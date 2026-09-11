/* ------------------------------------------------------------------ *
 *  Caller display name
 *
 *  `CallLog.callerName` is NOT safe to show raw. It defaults to "Unknown"
 *  (schema.prisma) for every call where the caller never gave a name, and the
 *  extraction model writes "unknown" / "n/a" / "" into structuredData.name for
 *  the same reason. Left alone, that placeholder travels all the way into an
 *  owner's CRM, where a whole page of leads reads "Unknown".
 *
 *  So anything that puts a caller in front of a human — CRM leads, owner
 *  notifications, the public call page — goes through callerLabel, and write
 *  paths use realCallerName so a placeholder is never stored as if it were a
 *  name the caller actually said.
 * ------------------------------------------------------------------ */

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

/** The name only when it's real, else undefined — for write paths that should
 *  leave the column at its default rather than store a placeholder, and for
 *  fallback chains (`realCallerName(x) || number || CALLER_FALLBACK`). */
export function realCallerName(raw?: string | null): string | undefined {
  return isPlaceholderCallerName(raw) ? undefined : raw!.trim();
}
