import crypto from "node:crypto";
import { prisma } from "../prisma.js";
import { env } from "../env.js";
import { currentBrandId } from "../lib/brandContext.js";
import { tenantFor, type TenantClient } from "./tenantDb.js";
import { badRequest, serviceUnavailable } from "../lib/http.js";
import { sendTemplate } from "./email.js";
import { integrationsStatus } from "./settings.js";
import { sendSms, isTwilioConfigured } from "./sms.js";
import { brandDisplayName } from "../lib/brandUrls.js";

/* ------------------------------------------------------------------ *
 *  Email OTP — sign-up verification & password reset.
 *  Codes are 6-digit, single-use, hashed at rest, expire after a few
 *  minutes, and are rate-limited by attempt count. The pending sign-up
 *  payload (passwordHash, name, business) rides along on the code row
 *  until the user verifies, so we never create a user before verification.
 * ------------------------------------------------------------------ */

export type OtpPurpose = "signup" | "password_reset" | "impersonation_pin_reset";

/** The template each purpose sends through. A map rather than a ternary, so
 *  adding a purpose is a compile error here instead of silently posting the
 *  wrong email — a PIN reset arriving as "reset your password" would read as a
 *  phishing attempt on the one account that must never be phished. */
const OTP_TEMPLATE: Record<OtpPurpose, string> = {
  signup: "email_verification",
  password_reset: "password_reset",
  impersonation_pin_reset: "impersonation_pin_reset",
};

export interface SignupPayload {
  passwordHash: string;
  fullName: string;
  businessName: string;
  /** Owner's personal mobile. */
  mobile?: string;
  /** Public business/support number callers ring. */
  businessNumber?: string;
  address?: string;
  referralCode?: string;
  /** True when the account is being created mid guided-onboarding funnel. */
  viaOnboarding?: boolean;
  /** IANA timezone the browser reported at signup (e.g. "Asia/Kolkata"). */
  timezone?: string;
  /** The `onboarding.cardRequired` policy as it stood when /register/start ran.
   *  Carried here rather than re-read at /register/verify so an admin flipping
   *  the toggle inside the OTP window can't stamp the account with a rule the
   *  user was never shown. */
  cardRequired?: boolean;
}

const CODE_TTL_MIN = 10;
const MAX_ATTEMPTS = 5;

function generateCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function hashCode(email: string, code: string): string {
  return crypto.createHash("sha256").update(`${email}:${code}:${env.JWT_SECRET}`).digest("hex");
}

/**
 * Where this door's codes live: the brand's own database, or — on the
 * platform's own door, for the platform's own people — the control plane's
 * table of the same shape. A code is issued and checked on the same door, so
 * the two stores never need to meet.
 */
type CodeStore = TenantClient["verificationCode"];
async function codes(): Promise<CodeStore> {
  const brandId = currentBrandId();
  if (brandId) return (await tenantFor(brandId)).verificationCode;
  return prisma.verificationCode as unknown as CodeStore;
}

/** Issue a fresh code, invalidating any outstanding one for the same email+purpose. */
export async function createOtp(opts: {
  email: string;
  purpose: OtpPurpose;
  payload?: SignupPayload;
}): Promise<string> {
  const { email, purpose, payload } = opts;
  const store = await codes();
  await store.deleteMany({ where: { email, purpose } });
  const code = generateCode();
  await store.create({
    data: {
      email,
      purpose,
      codeHash: hashCode(email, code),
      payload: payload as object | undefined,
      expiresAt: new Date(Date.now() + CODE_TTL_MIN * 60_000),
    },
  });
  return code;
}

/** Grace window in which a sign-up code stays "recoverable" after being consumed. */
const RECOVERY_TTL_MIN = 30;

/**
 * True if `code` matches the most recent sign-up OTP for `email` — even if it was
 * already consumed — within a short grace window. Lets `/register/verify` be
 * retried idempotently: if the first verify created the account but its response
 * was lost (slow/dropped, e.g. a cold DB), re-submitting the same code recovers
 * the session instead of failing with "Email already registered".
 */
export async function signupCodeMatches(email: string, code: string): Promise<boolean> {
  const row = await (await codes()).findFirst({
    where: { email, purpose: "signup" },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return false;
  if (row.createdAt.getTime() < Date.now() - RECOVERY_TTL_MIN * 60_000) return false;
  return row.codeHash === hashCode(email, code);
}

/** The details a pending sign-up left on its unconsumed code, for re-sending. */
export async function pendingSignupPayload(email: string): Promise<SignupPayload | null> {
  const prior = await (await codes()).findFirst({
    where: { email, purpose: "signup", consumedAt: null },
    orderBy: { createdAt: "desc" },
  });
  return (prior?.payload as SignupPayload | null | undefined) ?? null;
}

async function findValid(email: string, purpose: OtpPurpose) {
  const row = await (await codes()).findFirst({
    where: { email, purpose, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (!row) throw badRequest("No verification code found. Please request a new one.");
  if (row.expiresAt.getTime() < Date.now())
    throw badRequest("Verification code has expired. Please request a new one.");
  if (row.attempts >= MAX_ATTEMPTS)
    throw badRequest("Too many attempts. Please request a new code.");
  return row;
}

/** Check a code without consuming it; bumps the attempt counter on a wrong code. */
export async function verifyOtp(email: string, purpose: OtpPurpose, code: string) {
  const row = await findValid(email, purpose);
  if (row.codeHash !== hashCode(email, code)) {
    await (await codes()).update({
      where: { id: row.id },
      data: { attempts: { increment: 1 } },
    });
    throw badRequest("Incorrect verification code.");
  }
  return row;
}

/** Verify and mark the code used. Returns the row (incl. any pending payload). */
export async function consumeOtp(email: string, purpose: OtpPurpose, code: string) {
  const row = await verifyOtp(email, purpose, code);
  await (await codes()).update({
    where: { id: row.id },
    data: { consumedAt: new Date() },
  });
  return row;
}

export async function sendOtpEmail(email: string, code: string, purpose: OtpPurpose) {
  // Outside production, always print the code to the terminal so it's easy to
  // grab while testing — even when SMTP is configured and the email is sent.
  if (process.env.NODE_ENV !== "production") {
    console.log(`✉ [dev] OTP for ${email} (${purpose}): ${code}`);
  }

  // Dev fallback: with no SMTP configured, there's nothing to send.
  if (!integrationsStatus().email) {
    if (process.env.NODE_ENV === "production") {
      console.log(
        `✉ [dev] OTP for ${email} (${purpose}): ${code} — configure SMTP in Admin → Settings to email it`,
      );
    }
    return;
  }
  const templateKey = OTP_TEMPLATE[purpose];
  try {
    await sendTemplate(templateKey, email, {
      code,
      expiry_minutes: CODE_TTL_MIN,
    });
  } catch (err) {
    // Don't surface the raw provider/SMTP error (e.g. "535 email limit reached")
    // to the user — log it for ops and return a clean, friendly message.
    console.error(`Failed to send ${purpose} OTP email to ${email}:`, err);
    throw serviceUnavailable(
      "We couldn't send your verification code right now. Please try again in a few minutes.",
    );
  }
}

/**
 * Best-effort: also text the SAME verification code to the user's mobile, so they
 * can grab it from either their inbox or their phone. Deliberately non-throwing —
 * email is the primary channel; a missing number, unconfigured Twilio, or a carrier
 * failure must never block sign-up. Failures are logged for ops, not surfaced.
 */
export async function sendOtpSms(
  mobile: string | undefined,
  code: string,
  purpose: OtpPurpose,
): Promise<void> {
  const to = mobile?.trim();
  if (!to) return;

  if (process.env.NODE_ENV !== "production") {
    console.log(`📱 [dev] OTP SMS for ${to} (${purpose}): ${code}`);
  }

  // No Twilio configured — nothing to send; email already carries the code.
  if (!isTwilioConfigured()) return;

  // Whatever this tenant calls itself — a white-label customer verifying their
  // sign-up must not be told to confirm an account on a product they have never
  // heard of.
  const appName = brandDisplayName();

  // Lead with the code so it's the first thing the user sees, then say plainly
  // what it's for. Verification codes read best as "<code> is your … code".
  const purposeLine =
    purpose === "signup"
      ? `Enter it to finish creating your ${appName} account.`
      : `Enter it to reset your ${appName} password.`;
  try {
    await sendSms(
      to,
      `${code} is your ${appName} verification code. ${purposeLine} It expires in ${CODE_TTL_MIN} minutes.`,
    );
  } catch (err) {
    // Swallow — the emailed code still works; just record it for ops.
    console.error(`Failed to send ${purpose} OTP SMS to ${to}:`, err);
  }
}
