import express from "express";
import { z } from "zod";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { asyncHandler, badRequest, notImplemented } from "../lib/http.js";
import { getEffective } from "../services/settings.js";
import { traceFetch } from "../services/apiTrace.js";
import { rateLimit } from "../middleware/rateLimit.js";
import {
  deepgramVoiceFor,
  ELEVEN_DEFAULT_MODEL,
  ELEVEN_V3_MODEL,
  elevenLabsVoiceFor,
  needsElevenV3Voice,
  providerForVoiceId,
} from "../services/voices.js";

// TTS proxy: streams short snippets from Deepgram/ElevenLabs straight back so playback
// starts early. GET (usable as an <audio> src) and POST. Public; 501 until a key is set.

const router = express.Router();

const ttsSchema = z.object({
  text: z.string().min(1).max(600),
  voiceId: z.string().optional(),
  // Explicit when the picker knows it; otherwise derived from the voice id.
  provider: z.enum(["deepgram", "elevenlabs"]).optional(),
});

// Preview provider: explicit choice, else ElevenLabs voice_id → ElevenLabs, Deepgram
// name / empty → the global default. Mirrors the live agent so previews match calls.
function ttsProvider(voiceId: string | undefined, explicit?: "deepgram" | "elevenlabs") {
  return explicit ?? providerForVoiceId(voiceId);
}

async function synthesize(
  text: string,
  voiceId: string | undefined,
  provider: "deepgram" | "elevenlabs",
) {
  if (provider === "elevenlabs") {
    const apiKey = getEffective("elevenlabs.apiKey");
    if (!apiKey) throw notImplemented("ElevenLabs is not configured (set the ElevenLabs API key)");
    // Unknown/empty ids → the default ElevenLabs voice, so the preview always speaks.
    const voice = elevenLabsVoiceFor(voiceId);
    // Same model rule as the live agent; a preview has no language, so the voice alone decides.
    const model = needsElevenV3Voice(voice) ? ELEVEN_V3_MODEL : ELEVEN_DEFAULT_MODEL;
    return traceFetch(
      "elevenlabs",
      `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: model }),
      },
      // Both TTS vendors price per 1K characters, and the character count is
      // known before the call — so this cost is measured, not estimated.
      { units: text.length / 1000, endpoint: "/v1/text-to-speech/:id" },
    );
  }

  const apiKey = getEffective("deepgram.apiKey");
  if (!apiKey) throw notImplemented("Deepgram is not configured (set the Deepgram API key)");
  // Resolve to a valid catalog voice (unknown ids → default). Deepgram TTS model id
  // format: aura-2-<voice>-en (e.g. aura-2-theia-en).
  const model = `aura-2-${deepgramVoiceFor(voiceId)}-en`;
  return traceFetch(
    "deepgram",
    `https://api.deepgram.com/v1/speak?model=${model}`,
    {
      method: "POST",
      headers: { Authorization: `Token ${apiKey}`, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({ text }),
    },
    { units: text.length / 1000, endpoint: "/v1/speak" },
  );
}

const handleTts = asyncHandler(async (req, res) => {
  const { text, voiceId, provider } = ttsSchema.parse(req.method === "GET" ? req.query : req.body);

  const resp = await synthesize(text, voiceId, ttsProvider(voiceId, provider));

  if (!resp.ok || !resp.body) {
    const detail = await resp.text().catch(() => "");
    throw badRequest(`TTS failed: ${detail.slice(0, 200)}`);
  }

  res.setHeader("Content-Type", resp.headers.get("content-type") ?? "audio/mpeg");
  res.setHeader("Cache-Control", "public, max-age=86400");
  // Pipe Deepgram's audio straight through so the browser starts playing as soon
  // as the first chunks land, rather than buffering the whole clip server-side.
  Readable.fromWeb(resp.body as WebReadableStream<Uint8Array>).pipe(res);
});

// Public and unauthenticated, and every request bills a real synthesis — rate-limit
// per IP so it can't be looped to run up the bill. Text is capped at 600 chars.
const ttsLimiter = rateLimit({
  windowMs: 60_000,
  max: 40,
  message: "Too many voice previews — please wait a moment and try again.",
});

router.get("/", ttsLimiter, handleTts);
router.post("/", ttsLimiter, handleTts);

export default router;
