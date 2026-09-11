/* ------------------------------------------------------------------ *
 *  Vapi phone-call transcript → timed turns.
 *
 *  A phone call's end-of-call report gives the transcript as a plain string
 *  ("AI: …\nUser: …") with no per-turn timing, so the call detail showed every
 *  line at 0:00. Vapi ALSO sends a structured `artifact.messages` array where
 *  each spoken message carries `secondsFromStart` (and an epoch `time`). Building
 *  the transcript from that gives the same "Agent · 0:05 / Caller · 0:12"
 *  timeline the web widget already produces.
 * ------------------------------------------------------------------ */

export interface TimedTurn {
  /** Normalised to "agent" | "caller" to match the web-call transcript shape. */
  role: string;
  text: string;
  /** Seconds from the start of the call. */
  at: number;
}

/** Vapi roles that are actually spoken turns (everything else — system prompts,
 *  tool calls/results — is dropped). */
const SPOKEN_ROLE = /^(bot|assistant|ai|user|customer|human|caller)$/i;
const AGENT_ROLE = /^(bot|assistant|ai)$/i;

/**
 * Build timed transcript turns from Vapi's structured `artifact.messages`.
 * Returns `null` when the input isn't a usable messages array (so the caller can
 * fall back to the plain-string transcript). `at` comes from `secondsFromStart`
 * when present, else it's derived from each message's epoch `time` relative to
 * the earliest message; failing both, it defaults to 0.
 */
export function turnsFromVapiMessages(messages: unknown): TimedTurn[] | null {
  if (!Array.isArray(messages)) return null;

  const spoken = messages
    .filter((m): m is Record<string, unknown> => m != null && typeof m === "object")
    .map((m) => ({
      role: String(m.role ?? ""),
      text: String(m.message ?? m.content ?? "").trim(),
      secondsFromStart: typeof m.secondsFromStart === "number" ? m.secondsFromStart : undefined,
      time: typeof m.time === "number" ? m.time : undefined,
    }))
    .filter((m) => m.text && SPOKEN_ROLE.test(m.role));

  if (!spoken.length) return null;

  // Fallback timing base: the earliest epoch timestamp across the spoken turns.
  const baseTime = spoken.reduce(
    (min, m) => (m.time !== undefined && m.time < min ? m.time : min),
    Infinity,
  );

  return spoken.map((m) => {
    let at = 0;
    if (m.secondsFromStart !== undefined) {
      at = Math.max(0, Math.round(m.secondsFromStart));
    } else if (m.time !== undefined && baseTime !== Infinity) {
      at = Math.max(0, Math.round((m.time - baseTime) / 1000));
    }
    return { role: AGENT_ROLE.test(m.role) ? "agent" : "caller", text: m.text, at };
  });
}
