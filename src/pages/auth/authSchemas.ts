import { z } from "zod";

/* Validation schemas for the auth screens. Mirrors the backend rules in
 * server/src/routes/auth.routes.ts, with friendlier client-side messages and a
 * couple of stronger UX-only checks (password complexity on sign-up). */

const email = z
  .string()
  .trim()
  .min(1, "Email is required")
  .email("Enter a valid email address");

const strongPassword = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(40, "Password must be at most 40 characters")
  .regex(/[a-z]/, "Include a lowercase letter")
  .regex(/[A-Z]/, "Include an uppercase letter")
  .regex(/[^A-Za-z0-9]/, "Include a special character");

/** First failing strong-password rule, or undefined when the password is valid. */
export function passwordError(password: string): string | undefined {
  const r = strongPassword.safeParse(password);
  return r.success ? undefined : r.error.issues[0]?.message;
}

export const loginSchema = z.object({
  email,
  password: z.string().min(1, "Password is required"),
});

export const otpSchema = z.object({
  code: z.string().refine((v) => v.replace(/\D/g, "").length === 6, "Enter the 6-digit code"),
});

export const forgotSchema = z.object({ email });

export const resetSchema = z.object({
  code: z.string().refine((v) => v.replace(/\D/g, "").length === 6, "Enter the 6-digit code"),
  newPassword: strongPassword,
});

export const registerSchema = z.object({
  fullName: z.string().trim().min(2, "Enter your full name"),
  businessName: z.string().trim().optional(),
  email,
  password: strongPassword,
});

export type FieldErrors = Record<string, string>;

/** First error message per field, for inline display below each input. */
export function fieldErrors(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === "string" && !out[key]) out[key] = issue.message;
  }
  return out;
}
