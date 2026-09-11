/* ------------------------------------------------------------------ *
 *  Graceful close before a call hits its hard duration cap.
 *
 *  Vapi enforces `maxDurationSeconds` by simply dropping the call — no goodbye,
 *  mid-sentence. That is fine as an abuse backstop but brutal for a genuine
 *  caller who happens to run long, and it is the business's own customer who
 *  hears the line go dead.
 *
 *  So a few seconds before the cap we nudge the assistant, via Vapi's live call
 *  control channel, to close the conversation itself. It speaks in its own
 *  voice, language and style, and Vapi's hard cut is left as the backstop it
 *  should be rather than the normal path.
 *
 *  A system message (not a canned `say`) is used on purpose: a fixed sentence
 *  would be in the wrong language for a multilingual agent and would ignore
 *  whatever the caller just asked. Letting the model close means it can finish
 *  the thought — "I'll get someone to call you back about that" — instead of
 *  reciting a script over the top of the caller.
 *
 *  Timers live in memory. A restart loses any pending wrap-up, and the call then
 *  ends the old abrupt way at the cap — degraded, never broken, and not worth a
 *  scheduler table for a window measured in minutes.
 * ------------------------------------------------------------------------- */
import { WRAP_UP_LEAD_SECONDS } from "./callDurationCap.js";

/** What the assistant is told when the call is nearly out of time. Phrased as an
 *  instruction about what to DO, not words to say, so the model closes in the
 *  caller's language and picks up whatever is actually in flight. */
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
        // Speak now. Inserted silently, the model would only see this on its
        // next turn — which may never come if the caller is mid-monologue,
        // exactly the case this exists for.
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

/**
 * Arrange for `callId` to be told to close shortly before `capSeconds` elapses.
 *
 * `startedAt` is when the call actually began — a status-update can arrive late,
 * and measuring the delay from "now" would push the warning past the cap.
 * No-ops when the cap is too short to warn inside (the warning would land at or
 * before the call's start), when control is unavailable, or when this call is
 * already scheduled.
 */
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
