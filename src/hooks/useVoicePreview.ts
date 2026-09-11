import { useCallback, useEffect, useState } from "react";
import { speak, stopSpeaking } from "@/lib/speech";

/**
 * Plays a short spoken preview of a voice via the server TTS proxy (`/api/tts`).
 * There's no per-voice sample CDN, so we synthesise a line on the fly with the
 * voice itself. One preview at a time: toggling another voice stops the previous.
 * Returns the id currently playing so the UI can swap play/pause.
 *
 * Language-specific voices (the curated Chinese/Punjabi ones, which carry an ISO
 * `language` code) are previewed with a line IN THAT LANGUAGE — a Mandarin voice
 * reading an English sentence is not a useful sample of what a caller will hear.
 */
const PREVIEW_LINE = "Hi, I'm your AI receptionist. How can I help you today?";

/** Hindi and Punjabi verbs/pronouns agree with the speaker's gender (सकता/सकती,
 *  ਸਕਦਾ/ਸਕਦੀ), so those languages carry a line per gender — a male voice reading
 *  the feminine form sounds wrong to a native ear. Chinese has no grammatical
 *  gender, so one line serves all its voices. */
type GenderedLine = { male: string; female: string };

const PREVIEW_LINES: Record<string, string | GenderedLine> = {
  hi: {
    male: "नमस्ते! मैं आपका AI रिसेप्शनिस्ट हूँ। मैं आपकी कैसे मदद कर सकता हूँ?",
    female: "नमस्ते! मैं आपकी AI रिसेप्शनिस्ट हूँ। मैं आपकी कैसे मदद कर सकती हूँ?",
  },
  zh: "您好，我是您的 AI 接待员。请问有什么可以帮您？",
  pa: {
    male: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ, ਮੈਂ ਤੁਹਾਡਾ AI ਰਿਸੈਪਸ਼ਨਿਸਟ ਹਾਂ। ਮੈਂ ਤੁਹਾਡੀ ਕਿਵੇਂ ਮਦਦ ਕਰ ਸਕਦਾ ਹਾਂ?",
    female: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ, ਮੈਂ ਤੁਹਾਡੀ AI ਰਿਸੈਪਸ਼ਨਿਸਟ ਹਾਂ। ਮੈਂ ਤੁਹਾਡੀ ਕਿਵੇਂ ਮਦਦ ਕਰ ਸਕਦੀ ਹਾਂ?",
  },
  // Nepali's first person doesn't inflect for gender here, so one line covers
  // both — unlike Hindi/Punjabi above.
  ne: "नमस्ते! म तपाईंको एआई रिसेप्शनिस्ट हुँ। म तपाईंलाई कसरी मद्दत गर्न सक्छु?",
};

/** The sample line for a voice — its own language when it has one, else English.
 *  A gendered language picks the form matching the voice; unknown gender falls
 *  back to the feminine form (most of our curated voices are female). */
export function previewLineFor(
  language?: string,
  gender?: "male" | "female" | null,
): string {
  const line = language ? PREVIEW_LINES[language] : undefined;
  if (!line) return PREVIEW_LINE;
  if (typeof line === "string") return line;
  return gender === "male" ? line.male : line.female;
}

export function useVoicePreview() {
  const [playingId, setPlayingId] = useState<string | null>(null);

  const stop = useCallback(() => {
    stopSpeaking();
    setPlayingId(null);
  }, []);

  // Stop playback if the component using the hook unmounts.
  useEffect(() => () => stop(), [stop]);

  const toggle = useCallback(
    (
      id: string,
      provider?: "deepgram" | "elevenlabs",
      opts?: {
        language?: string;
        gender?: "male" | "female" | null;
        onError?: (message: string) => void;
      },
    ) => {
      if (playingId === id) {
        stop();
        return;
      }
      stopSpeaking();
      setPlayingId(id);
      speak(previewLineFor(opts?.language, opts?.gender), {
        voiceId: id,
        provider,
        onError: opts?.onError,
        onEnd: () => setPlayingId((p) => (p === id ? null : p)),
      });
    },
    [playingId, stop],
  );

  return { playingId, toggle, stop };
}
