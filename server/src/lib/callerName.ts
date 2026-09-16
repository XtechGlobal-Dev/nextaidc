// `CallLog.callerName` isn't safe to show raw — it defaults to "Unknown" and the extraction model writes
// "n/a"/"" too, which used to fill CRM pages with "Unknown". Read via callerLabel, write via realCallerName.

/** Shown wherever we have no real name. Neutral and true: it was a caller. */
export const CALLER_FALLBACK = "Caller";

/** Everything that means "the caller never told us their name": our own schema
 *  default, plus what the extraction model writes for a missing field. */
const PLACEHOLDERS: ReadonlySet<string> = new Set([
  "unknown",
  "unknown caller",
  "unknown name",
  "caller",
  "anonymous",
  "no name",
  "no caller id",
  "none",
  "null",
  "undefined",
  "n/a",
  "na",
  "not provided",
  "not given",
  "-",
  "--",
]);

/** True when `raw` carries no real name — empty, or one of the placeholders. */
export function isPlaceholderCallerName(raw?: string | null): boolean {
  const v = (raw ?? "").trim().toLowerCase().replace(/[\s_]+/g, " ");
  return v.length === 0 || PLACEHOLDERS.has(v);
}

/** The caller's name for anything a human reads, or "Caller" when we never got
 *  one. Never returns "Unknown". */
export function callerLabel(raw?: string | null): string {
  return isPlaceholderCallerName(raw) ? CALLER_FALLBACK : raw!.trim();
}

/** The name only when real, else undefined — so write paths never store a placeholder as a name. */
export function realCallerName(raw?: string | null): string | undefined {
  return isPlaceholderCallerName(raw) ? undefined : raw!.trim();
}
