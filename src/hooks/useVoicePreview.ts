import { useCallback, useEffect, useState } from "react";
import { speak, stopSpeaking } from "@/lib/speech";

// Voice preview via the server TTS proxy (/api/tts) — no sample CDN, so we synthesise a line.
// Voices with an ISO `language` get a line in that language; a Mandarin voice reading English is useless.
const PREVIEW_LINE = "Hi, I'm your AI receptionist. How can I help you today?";

// Hindi/Punjabi verbs agree with the speaker's gender (सकता/सकती), so those carry a line per
// gender; Chinese has no grammatical gender, one line does.
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

/** Sample line for a voice — its own language if it has one, else English. Unknown gender falls
 *  back to the feminine form (most curated voices are female). */
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
