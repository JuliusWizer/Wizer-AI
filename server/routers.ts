import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { invokeLLM } from "./_core/llm";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { protectedProcedure } from "./_core/trpc";
import { z } from "zod";
import * as db from "./db";
import { createPasswordSession, hashPassword, PASSWORD_SESSION_COOKIE, PASSWORD_SESSION_MAX_AGE, verifyPassword } from "./auth/password";
import { storagePut } from "./storage";
import { decodeProfileImage } from "./auth/avatar";
import { notifyOwner } from "./_core/notification";
import { buildChatMessages, buildMemoryContext } from "./chatPrompt";

const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(20000),
});

function safeMessages(value: string) {
  try {
    const parsed = JSON.parse(value);
    return z.array(chatMessageSchema).parse(parsed);
  } catch {
    return [];
  }
}

async function notifyChatFailure(input: { userId?: number; email?: string | null; message: string; error: unknown }) {
  const detail = input.error instanceof Error ? input.error.message : "Unknown AI failure";
  await notifyOwner({
    title: "Wizer AI conversation failed",
    content: `A Wizer AI question failed. User: ${input.email || `user ${input.userId ?? "guest"}`}. Question: ${input.message.slice(0, 500)}. Error: ${detail.slice(0, 1000)}`,
  }).catch(error => console.warn("[Chat] Owner failure notification could not be sent:", error));
}

export const appRouter = router({
    // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => {
      if (!opts.ctx.user) return null;
      const { passwordHash: _passwordHash, ...safeUser } = opts.ctx.user;
      return safeUser;
    }),
    register: publicProcedure
      .input(z.object({ name: z.string().trim().min(2).max(120), email: z.string().trim().email().max(320), password: z.string().min(8).max(128) }))
      .mutation(async ({ input, ctx }) => {
        const email = input.email.toLowerCase();
        if (await db.getUserByEmail(email)) throw new Error("An account with this email already exists.");
        const user = await db.createEmailUser({ name: input.name.trim(), email, passwordHash: await hashPassword(input.password) });
        if (!user) throw new Error("Could not create the account.");
        const token = createPasswordSession(user.id);
        ctx.res.cookie(PASSWORD_SESSION_COOKIE, token, { ...getSessionCookieOptions(ctx.req), maxAge: PASSWORD_SESSION_MAX_AGE * 1000 });
        const { passwordHash: _passwordHash, ...safeUser } = user;
        return safeUser;
      }),
    login: publicProcedure
      .input(z.object({ email: z.string().trim().email().max(320), password: z.string().min(1).max(128) }))
      .mutation(async ({ input, ctx }) => {
        const user = await db.getUserByEmail(input.email.toLowerCase());
        if (!user?.passwordHash || !(await verifyPassword(input.password, user.passwordHash))) throw new Error("Invalid email or password.");
        const token = createPasswordSession(user.id);
        ctx.res.cookie(PASSWORD_SESSION_COOKIE, token, { ...getSessionCookieOptions(ctx.req), maxAge: PASSWORD_SESSION_MAX_AGE * 1000 });
        const { passwordHash: _passwordHash, ...safeUser } = user;
        return safeUser;
      }),
    updateAvatar: publicProcedure
      .input(z.object({ dataUrl: z.string().startsWith("data:image/").max(1_500_000) }))
      .mutation(async ({ input, ctx }) => {
        if (!ctx.user) throw new Error("You must be signed in to update your profile.");
        const { contentType, extension, buffer } = decodeProfileImage(input.dataUrl);
        const uploaded = await storagePut(`avatars/${ctx.user.id}.${extension}`, buffer, contentType);
        const user = await db.updateUserAvatar(ctx.user.id, uploaded.url);
        if (!user) throw new Error("Could not update your profile.");
        const { passwordHash: _passwordHash, ...safeUser } = user;
        return safeUser;
      }),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      ctx.res.clearCookie(PASSWORD_SESSION_COOKIE, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  chat: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const rows = await db.listConversations(ctx.user.id);
      return rows.map(row => ({ id: row.id, title: row.title, messages: safeMessages(row.messages), updatedAt: row.updatedAt.getTime() }));
    }),
    upsert: protectedProcedure
      .input(z.object({ id: z.string().min(1).max(64), title: z.string().trim().min(1).max(255), messages: z.array(chatMessageSchema).max(100) }))
      .mutation(async ({ input, ctx }) => {
        const row = await db.upsertConversation({ id: input.id, userId: ctx.user.id, title: input.title, messages: JSON.stringify(input.messages) });
        if (!row) throw new Error("Could not save the conversation.");
        return { id: row.id, title: row.title, messages: safeMessages(row.messages), updatedAt: row.updatedAt.getTime() };
      }),
    delete: protectedProcedure
      .input(z.object({ id: z.string().min(1).max(64) }))
      .mutation(async ({ input, ctx }) => { await db.deleteConversation(ctx.user.id, input.id); return { success: true } as const; }),
    deleteAll: protectedProcedure
      .mutation(async ({ ctx }) => { await db.deleteAllConversations(ctx.user.id); return { success: true } as const; }),
    send: publicProcedure
      .input(z.object({
        message: z.string().trim().min(1).max(20000),
        conversationId: z.string().min(1).max(64).optional(),
        title: z.string().trim().min(1).max(255).optional(),
        history: z.array(chatMessageSchema).max(50).default([]),
        language: z.enum(["auto", "en", "sw", "ko", "fr", "zh", "ar"]).default("en"),
      }))
      .mutation(async ({ input, ctx }) => {
        try {
          const conversation = ctx.user && input.conversationId ? await db.getConversation(ctx.user.id, input.conversationId) : undefined;
          const history = conversation ? safeMessages(conversation.messages) : input.history;
          const memoryRows = ctx.user ? await db.listConversationMemory(ctx.user.id) : [];
          const userMessages = [...history, { role: "user" as const, content: input.message }];
          if (ctx.user && input.conversationId) {
            await db.upsertConversation({ id: input.conversationId, userId: ctx.user.id, title: input.title || input.message.slice(0, 34), messages: JSON.stringify(userMessages) });
          }
          const response = await invokeLLM({
            model: "gpt-4o-mini",
            messages: buildChatMessages({ history, message: input.message, language: input.language, memory: buildMemoryContext(memoryRows, input.conversationId) }),
          });

          const content = response.choices?.[0]?.message?.content;
          const answer = typeof content === "string"
            ? content.trim()
            : Array.isArray(content)
              ? content.filter(part => part.type === "text").map(part => part.text).join("\n").trim()
              : "";

          if (!answer) throw new Error("The AI returned an empty response.");
          if (ctx.user && input.conversationId) {
            await db.upsertConversation({ id: input.conversationId, userId: ctx.user.id, title: input.title || input.message.slice(0, 34), messages: JSON.stringify([...userMessages, { role: "assi[...]
          }
          return { response: answer };
        } catch (error) {
          await notifyChatFailure({ userId: ctx.user?.id, email: ctx.user?.email, message: input.message, error });
          throw error;
        }
      }),
    speak: publicProcedure
      .input(z.object({ text: z.string().trim().min(1).max(6000), language: z.enum(["en", "sw", "ko", "fr", "zh", "ar"]).default("en") }))
      .mutation(async ({ input }) => {
        const response = await fetch(`${process.env.BUILT_IN_FORGE_API_URL ?? ""}/v1/audio/speech`, {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.BUILT_IN_FORGE_API_KEY ?? ""}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "tts-1", voice: "alloy", input: input.text, response_format: "mp3" }),
        });
        if (!response.ok) throw new Error("Speech generation failed");
        const audio = Buffer.from(await response.arrayBuffer()).toString("base64");
        return { audio: `data:audio/mpeg;base64,${audio}` };
      }),
  }),

  // TODO: add feature routers here, e.g.
  // todo: router({
  //   list: protectedProcedure.query(({ ctx }) =>
  //     db.getUserTodos(ctx.user.id)
  //   ),
  // }),
});

export type AppRouter = typeof appRouter;
