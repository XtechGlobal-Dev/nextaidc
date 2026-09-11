/** Shared input limits.
 *
 *  Assistant & business display names are capped at 40 chars because Vapi caps
 *  an assistant's `name` at 40 — a longer name makes the assistant create/update
 *  400 and no assistant is provisioned. Keeping every entry point within this
 *  limit guarantees the live agent always builds. */
export const NAME_MAX = 40;

/** Clamp a display name to NAME_MAX characters. */
export const clampName = (s: string): string => (s ?? "").slice(0, NAME_MAX);

/** Opening greeting. Long enough for a sentence with the business name and a
 *  short offer of help, short enough that the agent doesn't monologue before the
 *  caller can speak — brevity is the whole point of the first line. */
export const GREETING_MAX = 160;
