import type { Request, Response } from "express";
import { z } from "zod";
import { createContext } from "./_core/context";
import { streamLLM } from "./_core/llm";
import { notifyOwner } from "./_core/notification";
import * as db from "./db";
import { buildChatMessages, buildMemoryContext } from "./chatPrompt";
import { storageGetSignedUrl, storagePut } from "./storage";
import { transcribeAudio } from "./_core/voiceTranscription";

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(20000),
});

const bodySchema = z.object({
  message: z.string().trim().min(1).max(20000),
  conversationId: z.string().min(1).max(64).optional(),
  title: z.string().trim().min(1).max(255).optional(),
  history: z.array(messageSchema).max(50).default([]),
  language: z.enum(["auto", "en", "sw", "ko", "fr", "zh", "ar"]).default("en"),
  attachments: z.array(z.object({ name: z.string().max(255), mimeType: z.string().max(150), dataUrl: z.string().max(25_000_000) })).max(4).default([]),
});

const textMimePattern = /^(text\/|application\/(json|csv|xml|javascript|sql)|image\/svg\+xml)$/i;
const imageMimePattern = /^image\/(jpeg|png|webp|gif)$/i;
const audioMimePattern = /^audio\/(webm|mpeg|wav|ogg|mp4|x-m4a|m4a)$/i;

function decodeDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error("Invalid uploaded file data.");
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length > 16 * 1024 * 1024) throw new Error("Files must be 16 MB or smaller.");
  return { mimeType: match[1].toLowerCase(), buffer };
}

async function prepareAttachments(attachments: z.infer<typeof bodySchema>["attachments"], language: string) {
  const multimodal: Array<{ type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } } | { type: "file_url"; file_url: { url: string; mime_type?: "application/pdf" | "audio/[...]
  const extracted: string[] = [];
  for (const attachment of attachments) {
    const decoded = decodeDataUrl(attachment.dataUrl);
    const mimeType = decoded.mimeType || attachment.mimeType.toLowerCase();
    if (textMimePattern.test(mimeType) || /\.(txt|csv|json|md|xml|js|ts|py|java|css|html|sql)$/i.test(attachment.name)) {
      extracted.push(`Attached file: ${attachment.name}\n${decoded.buffer.toString("utf8", 0, 120_000)}`);
      continue;
    }
    if (!imageMimePattern.test(mimeType) && mimeType !== "application/pdf" && !audioMimePattern.test(mimeType)) {
      throw new Error(`Wizer AI cannot read ${attachment.name} yet. Upload a PDF, text, CSV, image, or audio recording.`);
    }
    const stored = await storagePut(`chat-files/${Date.now()}-${attachment.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`, decoded.buffer, mimeType);
    const signedUrl = await storageGetSignedUrl(stored.key);
    if (audioMimePattern.test(mimeType)) {
      const transcript = await transcribeAudio({ audioUrl: signedUrl, language: language === "auto" ? undefined : language });
      if ("text" in transcript && transcript.text) extracted.push(`Voice recording (${attachment.name}) transcript:\n${transcript.text}`);
      else throw new Error("The voice recording could not be transcribed.");
    } else if (imageMimePattern.test(mimeType)) {
      multimodal.push({ type: "image_url", image_url: { url: signedUrl, detail: "auto" } });
    } else {
      multimodal.push({ type: "file_url", file_url: { url: signedUrl, mime_type: "application/pdf" } });
    }
  }
  return { multimodal, extracted };
}

function writeEvent(res: Response, event: Record<string, unknown>) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function notifyFailure(userId: number | undefined, email: string | null | undefined, question: string, error: unknown) {
  const detail = error instanceof Error ? error.message : "Unknown streaming failure";
  await notifyOwner({
    title: "Wizer AI streaming conversation failed",
    content: `A streamed Wizer AI question failed. User: ${email || `user ${userId ?? "guest"}`}. Question: ${question.slice(0, 500)}. Error: ${detail.slice(0, 1000)}`,
  }).catch(notificationError => console.warn("[Chat stream] Owner notification failed:", notificationError));
}

export async function registerChatStream(req: Request, res: Response) {
  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  let finished = false;
  const controller = new AbortController();
  let ownerId: number | undefined;
  let ownerEmail: string | null | undefined;
  // The request's close event fires when the POST body has been consumed, even
  // while the response is still streaming. Only abort when the client closes
  // the response connection.
  res.on("close", () => {
    if (!finished) controller.abort();
  });

  try {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) throw new Error("Invalid chat request.");
    const input = parsed.data;
    const prepared = await prepareAttachments(input.attachments, input.language);
    const message = prepared.extracted.length ? `${input.message}\n\n${prepared.extracted.join("\n\n")}` : input.message;
    const ctx = await createContext({ req, res } as Parameters<typeof createContext>[0]);
    ownerId = ctx.user?.id;
    ownerEmail = ctx.user?.email;
    const conversation = ctx.user && input.conversationId ? await db.getConversation(ctx.user.id, input.conversationId) : undefined;
    const history = conversation ? JSON.parse(conversation.messages) as z.infer<typeof messageSchema>[] : input.history;
    const memoryRows = ctx.user ? await db.listConversationMemory(ctx.user.id) : [];
    const userMessages = [...history, { role: "user" as const, content: message }];
    const title = input.title || message.slice(0, 34);

    if (ctx.user && input.conversationId) {
      await db.upsertConversation({ id: input.conversationId, userId: ctx.user.id, title, messages: JSON.stringify(userMessages) });
    }

    let answer = "";
    writeEvent(res, { type: "start" });
    await streamLLM({ 
      model: "gpt-4o-mini",
      messages: buildChatMessages({ history, message, language: input.language, memory: buildMemoryContext(memoryRows, input.conversationId), attachments: prepared.multimodal }) 
    }, (text) => {
      answer += text;
      if (!finished) writeEvent(res, { type: "delta", text });
    }, controller.signal);

    answer = answer.trim();
    if (!answer) throw new Error("The AI returned an empty response.");
    if (ctx.user && input.conversationId) {
      await db.upsertConversation({ id: input.conversationId, userId: ctx.user.id, title, messages: JSON.stringify([...userMessages, { role: "assistant", content: answer }]) });
    }
    if (!finished) {
      writeEvent(res, { type: "done" });
      finished = true;
      res.end();
    }
  } catch (error) {
    await notifyFailure(ownerId, ownerEmail, typeof req.body?.message === "string" ? req.body.message : "Unknown question", error);
    if (!finished && !res.writableEnded) {
      writeEvent(res, { type: "error", message: error instanceof Error ? error.message : "The AI could not complete this response." });
      finished = true;
      res.end();
    }
  }
}
