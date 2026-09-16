/** Vapi caps an assistant's `name` at 40 chars; anything longer 400s on create/update and no assistant is provisioned. */
export const NAME_MAX = 40;

/** Clamp a display name to NAME_MAX characters. */
export const clampName = (s: string): string => (s ?? "").slice(0, NAME_MAX);

/** Opening greeting cap: room for the business name and an offer of help, short enough the agent doesn't monologue. */
export const GREETING_MAX = 160;
