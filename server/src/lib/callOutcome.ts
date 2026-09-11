import { CallOutcome } from "@prisma/tenant-client";

/** Map Vapi's end-of-call `endedReason` to our CallOutcome. Vapi sends reasons like
 *  "customer-ended-call" / "assistant-ended-call" (completed), "voicemail",
 *  "customer-did-not-answer" / "customer-busy" (missed), and "*-error" (failed).
 *  Without this every webhook call falls back to the schema default (completed). */
export function deriveOutcome(endedReason: unknown, durationSec: number | undefined): CallOutcome {
  const r = String(endedReason ?? "").toLowerCase();
  if (r.includes("voicemail")) return CallOutcome.voicemail;
  if (
    r.includes("no-answer") ||
    r.includes("did-not-answer") ||
    r.includes("noanswer") ||
    r.includes("busy") ||
    r.includes("missed")
  ) {
    return CallOutcome.missed;
  }
  if (r.includes("error") || r.includes("failed") || r.includes("failure") || r.includes("rejected")) {
    return CallOutcome.failed;
  }
  // Unknown reason + zero duration → the call never really connected → missed.
  if (!r && !durationSec) return CallOutcome.missed;
  return CallOutcome.completed;
}
