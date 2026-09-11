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

/* ------------------------------------------------------------------ *
 *  Text-to-speech proxy — synthesises short snippets with the active
 *  voice provider (Deepgram Aura-2 by default, ElevenLabs when the
 *  admin flips the global toggle) and STREAMS the audio straight back,
 *  so playback can begin as bytes arrive (low time-to-first-sound)
 *  instead of waiting for the whole clip.
 *
 *  Exposed as GET (so the browser can use it directly as an <audio>
 *  src and play progressively + cache it) and POST. Public — runs
 *  before the user has an account. 501 until the provider key is set.
 * ------------------------------------------------------------------ */

const router = express.Router();

const ttsSchema = z.object({
  text: z.string().min(1).max(600),
  voiceId: z.string().optional(),
  // Explicit provider (the picker knows it) so a preview always uses the right
  // engine. Omitted → derived: an ElevenLabs voice_id → ElevenLabs; a Deepgram
  // name / empty (e.g. the public landing preview) → the global default.
  provider: z.enum(["deepgram", "elevenlabs"]).optional(),
});

/** Synthesise `text` with the given voice via the active provider, returning the
 *  upstream streaming response. Mirrors the provider used by the live agent so the
 *  preview always matches what a caller will hear. */
/** Resolve which provider synthesises a preview: the explicit choice if given, else
 *  an ElevenLabs voice_id → ElevenLabs, a Deepgram name / empty → the global default. */
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
    // Mirrors the live agent's model choice (services/voices.ts elevenLabsModelFor).
    // A preview carries no language selection, but previewing a pinned v3 voice
    // IS that language's case — so the voice alone decides here.
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

// Public and unauthenticated (it runs before signup), so every request bills a
// real ElevenLabs/Deepgram synthesis. Rate-limit per IP so it can't be looped to
// run up the provider bill. Generous enough for a visitor auditioning voices;
// text is already capped at 600 chars, bounding the cost of each call.
const ttsLimiter = rateLimit({
  windowMs: 60_000,
  max: 40,
  message: "Too many voice previews — please wait a moment and try again.",
});

router.get("/", ttsLimiter, handleTts);
router.post("/", ttsLimiter, handleTts);

export default router;
