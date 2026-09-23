// Deciding whether a test call may dial the SAVED assistant as-is, or has to
// rebuild the payload from an unsaved AI-Brain draft.
//
// This is a correctness call before it is a speed one: say "unchanged" about a
// draft that did change and the caller hears the previous agent on a call they
// placed to check an edit. Say "changed" about an identical draft and every call
// pays an LLM prompt compression it did not need.

/** Stable JSON — object keys sorted, `undefined` dropped.
 *
 *  The draft arrives as JSON from the browser and the saved copy comes back from
 *  Postgres' jsonb, and neither preserves the other's key order. A plain
 *  `JSON.stringify` comparison would call every draft changed. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

/** Is this a real AI-Brain draft rather than an absent body or junk?
 *
 *  All four sections are required: a partial object would compile into a prompt
 *  missing whole chunks of the agent's behaviour. */
export function isFullConfig(draft: unknown): boolean {
  const d = draft as Record<string, unknown> | undefined;
  return Boolean(d?.identity && d?.advanced && d?.knowledge && d?.rules);
}

/** True when the request carries a draft that genuinely differs from what is
 *  saved — the only case where the live assistant can't be dialled as-is. */
export function draftDiffersFromSaved(draft: unknown, saved: unknown): boolean {
  if (!isFullConfig(draft)) return false;
  return stableJson(draft) !== stableJson(saved);
}
