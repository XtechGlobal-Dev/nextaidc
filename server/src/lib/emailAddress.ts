import { z } from "zod";

// One spelling for an account email everywhere it is typed: trimmed and lowercased, the way a profile save
// stores it. Older rows may still hold the casing they were registered with, so lookups match ignoring case.

/** An email field on an auth or profile form, normalized on parse. */
export const emailField = () => z.string().trim().toLowerCase().email();

/** A Prisma filter matching this email whatever casing it was stored with. */
export function sameEmail(email: string) {
  return { equals: email.trim(), mode: "insensitive" as const };
}
