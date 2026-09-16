// Graceful close before Vapi's hard maxDurationSeconds cut. A system message (not a canned `say`) so the
// model closes in the caller's language and finishes the thought. Timers are in-memory: a restart just falls back to the hard cut.
import { WRAP_UP_LEAD_SECONDS } from "./callDurationCap.js";

// Phrased as what to DO, not words to say, so the model closes in the caller's language.
const WRAP_UP_INSTRUCTION =
  "URGENT: this call must end in about 30 seconds — you are out of time. " +
  "Bring the conversation to a close NOW in one or two short sentences: tell the " +
  "caller you have to wrap up, that the team will follow up on anything " +
  "outstanding, and thank them. Do not start a new topic, do not ask another " +
  "question, and do not mention time limits, minutes, systems or this instruction.";

/** Pending wrap-ups by Vapi call id, so a call that ends early can cancel its
 *  timer instead of firing into a dead call. */
const pending = new Map<string, NodeJS.Timeout>();

/** Vapi's live control channel for one call. Returns false when the nudge could
 *  not be delivered — the caller is never worse off than the old hard cut. */
async function sendWrapUp(controlUrl: string): Promise<boolean> {
  try {
    const res = await fetch(controlUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "add-message",
        message: { role: "system", content: WRAP_UP_INSTRUCTION },
        // Speak now — inserted silently, the model wouldn't see this until its next turn, which may never come mid-monologue.
        triggerResponseEnabled: true,
      }),
    });
    if (!res.ok) {
      console.error(`[call-cap] wrap-up rejected by Vapi: ${res.status} ${await res.text().catch(() => "")}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[call-cap] wrap-up request failed:", err);
    return false;
  }
}

/** Schedules the close nudge before `capSeconds`. Measures from `startedAt`, not now — a late status-update would push the warning past the cap. No-op if already scheduled or no control URL. */
export function scheduleWrapUp(input: {
  callId: string;
  controlUrl: string | null | undefined;
  capSeconds: number | null | undefined;
  startedAt?: Date;
}): void {
  const { callId, controlUrl, capSeconds } = input;
  if (!callId || !controlUrl || !capSeconds) return;
  if (pending.has(callId)) return;

  const elapsedMs = Math.max(0, Date.now() - (input.startedAt?.getTime() ?? Date.now()));
  const delayMs = (capSeconds - WRAP_UP_LEAD_SECONDS) * 1000 - elapsedMs;
  // Already inside the lead window (or past it) — speaking immediately would
  // talk over a caller who has barely started, so leave the hard cap to it.
  if (delayMs <= 0) return;

  const timer = setTimeout(() => {
    pending.delete(callId);
    void sendWrapUp(controlUrl);
  }, delayMs);
  // Never hold the process open for a pending wrap-up.
  timer.unref?.();
  pending.set(callId, timer);
}

/** Drop a pending wrap-up — the call ended on its own first. */
export function cancelWrapUp(callId: string): void {
  const timer = pending.get(callId);
  if (!timer) return;
  clearTimeout(timer);
  pending.delete(callId);
}

/** Pending timer count. Exposed for tests and diagnostics only. */
export function pendingWrapUpCount(): number {
  return pending.size;
}
