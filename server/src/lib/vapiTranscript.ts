// Vapi transcript → timed turns. The plain-string transcript has no timing (every line showed 0:00);
// `artifact.messages` carries `secondsFromStart` per spoken message.

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

/** Timed turns from `artifact.messages`; null when unusable so the caller falls back to the string.
 *  `at` = secondsFromStart, else epoch `time` relative to the earliest, else 0. */
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
