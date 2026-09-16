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

// Email OTP: 6-digit, single-use, hashed at rest, attempt-limited. The pending
// sign-up payload rides on the code row so no user exists before verification.

export type OtpPurpose = "signup" | "password_reset" | "impersonation_pin_reset";

// A map, not a ternary: a new purpose is a compile error here instead of a
// PIN reset silently arriving as "reset your password" (reads as phishing).
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
  /** cardRequired policy snapshotted at /register/start, so a toggle flipped mid-OTP can't stamp a rule the user never saw. */
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

// Codes live in the brand's DB, or the control plane's same-shaped table on the
// platform door. Issued and checked on the same door, so the stores never meet.
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

/** Matches the latest sign-up code even if consumed (within a grace window), so a verify whose response was lost can be retried instead of hitting "Email already registered". */
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

/** Also texts the same code. Never throws — email is the primary channel and SMS trouble must not block sign-up. */
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

  // Tenant's own name: a white-label customer must not see a product they've never heard of.
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
