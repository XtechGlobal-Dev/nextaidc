import type { BadgeProps } from "@/components/ui/badge";
import type { CallIntent, CallLog, CallOutcome, Sentiment } from "@/types";

/* ------------------------------------------------------------------ *
 *  Call intent — "what was this call about?"
 *
 *  Outcome answers "did the call work?"; intent answers "is this worth my
 *  time?". They're orthogonal, so both pills show side by side: a call can be
 *  Completed AND a Booking, or Completed AND spam.
 * ------------------------------------------------------------------ */

/** Filter order, most valuable to the owner first. */
export const CALL_INTENTS: CallIntent[] = ["booking", "lead", "enquiry", "support", "spam"];

export const INTENT_LABELS: Record<CallIntent, string> = {
  booking: "Booking",
  lead: "New lead",
  enquiry: "Enquiry",
  support: "Support",
  spam: "Spam",
};

/** One-line explanations, used in the filter dropdown so the categories are
 *  self-explanatory without a help page. */
export const INTENT_HINTS: Record<CallIntent, string> = {
  booking: "Wanted an appointment",
  lead: "Potential new customer",
  enquiry: "General question",
  support: "Existing customer issue",
  spam: "Wrong number or robocall",
};

export function intentVariant(intent: CallIntent): NonNullable<BadgeProps["variant"]> {
  switch (intent) {
    case "booking":
      return "success";
    case "lead":
      return "premium";
    case "enquiry":
      return "primary";
    case "support":
      return "warning";
    case "spam":
      return "neutral";
  }
}

/** The category pill for a call, or null when it was never classified (old
 *  rows) — better no badge than a wrong one. */
export function intentBadge(
  call: Pick<CallLog, "intent">,
): { label: string; variant: NonNullable<BadgeProps["variant"]> } | null {
  const intent = call.intent;
  if (!intent || !(intent in INTENT_LABELS)) return null;
  return { label: INTENT_LABELS[intent as CallIntent], variant: intentVariant(intent as CallIntent) };
}

export const OUTCOME_LABELS: Record<CallOutcome, string> = {
  completed: "Completed",
  missed: "Missed",
  failed: "Failed",
  voicemail: "Voicemail",
};

/** Badge variant for a call outcome pill. */
export function outcomeVariant(outcome: CallOutcome): NonNullable<BadgeProps["variant"]> {
  switch (outcome) {
    case "completed":
      return "success";
    case "missed":
      return "warning";
    case "failed":
      return "danger";
    case "voicemail":
      return "primary";
  }
}

/** A pill describing the human-transfer result of a call, or null when no
 *  transfer was involved. "failed" is the one the owner must act on — a caller
 *  wanted a person but couldn't be connected, so call them back. */
export function transferBadge(
  call: Pick<CallLog, "transferOutcome" | "requestedDepartment">,
): { label: string; variant: NonNullable<BadgeProps["variant"]> } | null {
  const dept = call.requestedDepartment?.trim();
  const named = dept && dept.toLowerCase() !== "a person" ? dept : "";
  if (call.transferOutcome === "failed") {
    return { label: named ? `Transfer missed · ${named}` : "Transfer missed", variant: "danger" };
  }
  if (call.transferOutcome === "connected") {
    return { label: named ? `Transferred · ${named}` : "Transferred", variant: "success" };
  }
  return null;
}

/** Values that mean "the caller never gave a name": the stored default
 *  ("Unknown"), and what the extraction model writes for a missing field.
 *  Mirrors server/src/lib/callerName.ts, which does the same for CRM leads,
 *  owner notifications and the public call page. */
const NAME_PLACEHOLDERS = new Set([
  "unknown",
  "unknown caller",
  "unknown name",
  "caller",
  "anonymous",
  "no name",
  "none",
  "null",
  "n/a",
  "na",
  "not provided",
  "not given",
  "-",
]);

/** Display name for a call's caller — falls back to "Caller" when the name is
 *  missing or a placeholder, so the UI never shows "Unknown". */
export function callerLabel(name?: string | null): string {
  const n = name?.trim();
  if (!n) return "Caller";
  return NAME_PLACEHOLDERS.has(n.toLowerCase().replace(/[\s_]+/g, " ")) ? "Caller" : n;
}

/** Badge variant for a sentiment chip. */
export function sentimentVariant(sentiment: Sentiment): NonNullable<BadgeProps["variant"]> {
  switch (sentiment) {
    case "Positive":
      return "success";
    case "Negative":
      return "danger";
    case "Neutral":
      return "neutral";
  }
}

export interface CallStats {
  total: number;
  successPct: number;
  avgCompletedSec: number;
  missedPct: number;
}

/** Compute the stat-strip values from a (filtered) set of calls. */
export function computeStats(calls: CallLog[]): CallStats {
  const total = calls.length;
  const completed = calls.filter((c) => c.outcome === "completed");
  const missed = calls.filter((c) => c.outcome === "missed");
  const avgCompletedSec =
    completed.length === 0
      ? 0
      : Math.round(completed.reduce((sum, c) => sum + c.durationSec, 0) / completed.length);
  return {
    total,
    successPct: total === 0 ? 0 : Math.round((completed.length / total) * 100),
    avgCompletedSec,
    missedPct: total === 0 ? 0 : Math.round((missed.length / total) * 100),
  };
}

export type DatePreset = "all" | "today" | "7d" | "30d";

export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  all: "All time",
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

/** Returns true if the call falls within the given date preset window. */
export function withinPreset(call: CallLog, preset: DatePreset, now: number): boolean {
  if (preset === "all") return true;
  const created = new Date(call.createdAt).getTime();
  const day = 24 * 60 * 60 * 1000;
  if (preset === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return created >= start.getTime();
  }
  const windowMs = preset === "7d" ? 7 * day : 30 * day;
  return created >= now - windowMs;
}
