import type { Request, Response } from "express";
import { storageGetSignedUrl, storagePut } from "./storage";
import { transcribeAudio } from "./_core/voiceTranscription";

export async function registerVoiceTranscription(req: Request, res: Response) {
  try {
    const dataUrl = typeof req.body?.dataUrl === "string" ? req.body.dataUrl : "";
    const language = typeof req.body?.language === "string" && req.body.language !== "auto" ? req.body.language : undefined;
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: "Invalid voice recording." });
    const mimeType = match[1].toLowerCase();
    if (!/^audio\/(webm|mpeg|wav|ogg|mp4|x-m4a|m4a)$/i.test(mimeType)) return res.status(400).json({ error: "Unsupported voice recording format." });
    const buffer = Buffer.from(match[2], "base64");
    if (buffer.length > 16 * 1024 * 1024) return res.status(413).json({ error: "Voice recordings must be 16 MB or smaller." });
    const stored = await storagePut(`voice-messages/${Date.now()}.webm`, buffer, mimeType);
    const signedUrl = await storageGetSignedUrl(stored.key);
    const result = await transcribeAudio({ audioUrl: signedUrl, language });
    if (!("text" in result) || !result.text.trim()) return res.status(422).json({ error: "No speech was detected in the recording." });
    return res.json({ text: result.text.trim(), language: result.language });
  } catch (error) {
    console.error("[Voice] Transcription failed:", error);
    return res.status(500).json({ error: "Voice transcription failed. Please try again." });
  }
}
