import express from "express";
import { z } from "zod";
import { isValidPhoneNumber, parsePhoneNumberFromString } from "libphonenumber-js/max";
import { prisma } from "../prisma.js";
import { asyncHandler, badRequest, unauthorized, notFound, HttpError } from "../lib/http.js";
import { signToken } from "../lib/jwt.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { serializeUser } from "../lib/serialize.js";
import { requireAuth } from "../middleware/auth.js";
import { DEFAULT_AGENT_CONFIG, clampName, titleCaseName } from "../lib/agentConfig.js";
import {
  createOtp,
  consumeOtp,
  sendOtpEmail,
  sendOtpSms,
  signupCodeMatches,
  pendingSignupPayload,
  type SignupPayload,
} from "../services/otp.js";
import { integrationsStatus, getOnboardingCardRequired } from "../services/settings.js";
import { sendEmail } from "../services/email.js";
import { reconcileSubscription } from "../services/trial.js";
import { escapeHtml } from "../lib/escapeHtml.js";
import { formatSignupTime, isValidTimeZone, resolveBusinessTimeZone } from "../lib/phoneTimeZone.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { notify, notifyBrandAdmins } from "../services/notifications.js";
import { currentBrandId } from "../lib/brandContext.js";
import { brandDisplayName } from "../lib/brandUrls.js";
import { cachedBrand, brandOrigin } from "../services/brands.js";
import { brandAllowsSignup } from "../services/brandSetup.js";
import { tenantFor, tenantForUser, TenantUnavailableError, planeOf, type TenantClient } from "../services/tenantDb.js";

/** Staff role name, looked up (not joined) in the account's own plane — brand roles live in the brand DB. Missing reads as none. */
async function withStaffRole<T extends { staffRoleId: string | null; brandId: string | null }>(
  user: T,
): Promise<T & { staffRole: { name: string } | null }> {
  if (!user.staffRoleId) return { ...user, staffRole: null };
  const role = await planeOf(user.brandId)
    .then((db) => db.staffRole.findUnique({ where: { id: user.staffRoleId! }, select: { name: true } }))
    .catch(() => null);
  return { ...user, staffRole: role };
}

/** The account behind a session, read from its own plane and shaped for serializeUser. Null when the row is gone. */
async function loadAccount(id: string, brandId: string | null) {
  const db = await planeOf(brandId);
  const user = await db.user.findUnique({ where: { id } });
  if (!user) return null;
  const profile = brandId ? await db.profile.findUnique({ where: { userId: id } }) : null;
  const brand = cachedBrand(brandId);
  return {
    ...user,
    profile,
    brandId,
    brand: brand ? { name: brand.name, slug: brand.slug, status: brand.status } : null,
  };
}

/** The door's database, for a sign-up: every account is created inside a brand. */
async function signupTenant(): Promise<{ brandId: string; db: TenantClient }> {
  const brandId = currentBrandId();
  if (!brandId) {
    throw new HttpError(
      403,
      "Accounts are created on your provider's own website — sign up there.",
      "signup_closed",
    );
  }
  try {
    return { brandId, db: await tenantFor(brandId) };
  } catch (e) {
    if (e instanceof TenantUnavailableError) {
      throw new HttpError(503, "This brand is still being set up. Try again shortly.", "brand_not_ready");
    }
    throw e;
  }
}

/** Why a switched-off brand's people can't sign in. Suspended = off for now; deactivated = a super
 *  admin retired it, and it is deleted 30 days on unless they change their mind. */
function brandOfflineMessage(status: "suspended" | "deactivated"): string {
  return status === "deactivated"
    ? "This brand has been deactivated. Please contact support if you think this is a mistake."
    : "This brand is currently suspended. Please contact support if you think this is a mistake.";
}

const router = express.Router();

/** Finds the account for an email ON THIS DOOR: the brand's DB first, then the control plane (platform people only —
 *  they may sign in anywhere). An account behind another door is told where to go instead of "wrong password". */
async function findAccountOnThisDoor(
  email: string,
): Promise<{ id: string; passwordHash: string; brandId: string | null } | null> {
  const door = currentBrandId();
  if (door) {
    let tenant;
    try {
      tenant = await tenantFor(door);
    } catch (e) {
      if (e instanceof TenantUnavailableError) {
        throw new HttpError(503, "This brand is still being set up. Try again shortly.", "brand_not_ready");
      }
      throw e;
    }
    const row = await tenant.user.findUnique({
      where: { email },
      select: { id: true, passwordHash: true },
    });
    if (row) return { ...row, brandId: door };
  }
  // The platform's own people — the only accounts in the control plane — may
  // sign in on any door.
  const own = await prisma.user.findUnique({ where: { email }, select: { id: true, passwordHash: true } });
  if (own) return { ...own, brandId: null };
  // Not here. Main's directory knows which door they belong to — say that, not "wrong password".
  const elsewhere = await prisma.customerDirectory.findFirst({
    where: { email, ...(door ? { brandId: { not: door } } : {}) },
    select: { brandId: true },
  });
  if (!elsewhere) return null;
  const home = cachedBrand(elsewhere.brandId);
  if (home?.status === "suspended" || home?.status === "deactivated") {
    throw new HttpError(403, brandOfflineMessage(home.status), "account_suspended");
  }
  if (home && home.status !== "active") {
    throw new HttpError(403, "This brand is still being set up. Try again shortly.", "brand_not_ready");
  }
  throw new HttpError(
    403,
    `This account belongs to ${home?.name ?? "another brand"} — sign in at ${
      (home && brandOrigin(home)) || "that brand's own website"
    }.`,
    "wrong_door",
  );
}
/** Best-effort: email every admin a new customer signed up, with their details. */
async function notifyAdminsOfSignup(details: {
  fullName: string;
  email: string;
  businessName: string;
  mobile?: string;
  businessNumber?: string;
  address?: string;
  referralCode?: string;
  /** IANA timezone the browser reported at signup, if any. */
  timezone?: string;
}) {
  if (!integrationsStatus().email) return;
  // The brand's own admins only — the super admin has no access to any
  // brand's customer panel, so a per-customer signup isn't theirs to act on.
  const brandId = currentBrandId();
  const brandAdmins = brandId
    ? await tenantFor(brandId)
        .then((db) => db.user.findMany({ where: { role: "ADMIN" }, select: { email: true } }))
        .catch(() => [])
    : [];
  const admins = brandAdmins;
  if (!admins.length) return;

  const row = (label: string, value?: string) =>
    value && value.trim() ? `<li><strong>${label}:</strong> ${escapeHtml(value.trim())}</li>` : "";
  // Customer's own timezone (browser, else phone-derived), labelled so admins don't read it as UTC.
  const when = formatSignupTime(new Date(), { timezone: details.timezone, mobile: details.mobile });

  await sendEmail({
    to: admins.map((a) => a.email).join(","),
    subject: `New signup: ${details.businessName || details.fullName}`,
    html:
      `<h2>New customer signup</h2>` +
      `<p>A new customer just signed up and started their free trial. No action needed — they go live automatically once they add a plan and claim a number.</p>` +
      `<ul>` +
      row("Name", details.fullName) +
      row("Email", details.email) +
      row("Mobile", details.mobile) +
      row("Business", details.businessName) +
      row("Business number", details.businessNumber) +
      row("Address", details.address) +
      row("Referral code", details.referralCode) +
      `<li><strong>Signed up:</strong> ${escapeHtml(when)}</li>` +
      `</ul>` +
      `<p>Review them in Admin → Customers.</p>`,
  });
}

/** Best-effort: email + in-app notify the reseller when someone signs up through
 *  their referral link, with the new customer's details. */
async function notifyReferrerOfSignup(
  referrerId: string,
  details: {
    fullName: string;
    email: string;
    businessName: string;
    mobile?: string;
    businessNumber?: string;
    address?: string;
  },
): Promise<void> {
  const reseller = await tenantForUser(referrerId)
    .then((db) => db.user.findUnique({ where: { id: referrerId }, select: { email: true, fullName: true } }))
    .catch(() => null);
  if (!reseller) return;

  void notify(referrerId, {
    type: "new_lead",
    title: "New referral signup 🎉",
    message: `${details.fullName}${details.businessName ? ` (${details.businessName})` : ""} signed up using your referral link.`,
    link: "/reseller",
  });

  if (!integrationsStatus().email) return;
  const row = (label: string, value?: string) =>
    value && value.trim() ? `<li><strong>${label}:</strong> ${escapeHtml(value.trim())}</li>` : "";
  await sendEmail({
    to: reseller.email,
    subject: `New referral signup: ${details.businessName || details.fullName}`,
    html:
      `<p>Hi ${escapeHtml(reseller.fullName)},</p>` +
      `<p>Good news — a new customer just signed up using your referral link:</p>` +
      `<ul>` +
      row("Name", details.fullName) +
      row("Email", details.email) +
      row("Business", details.businessName) +
      row("Mobile", details.mobile) +
      row("Business number", details.businessNumber) +
      row("Address", details.address) +
      `</ul>` +
      `<p>You'll earn commission once they're on a paid plan. Track your referrals in your reseller portal.</p>`,
  });
}

/** Resolve a referral code to a reseller's user id (if valid). */
async function resolveReferrer(referralCode?: string): Promise<string | undefined> {
  if (!referralCode?.trim()) return undefined;
  const door = currentBrandId();
  if (!door) return undefined;
  const reseller = await tenantFor(door)
    .then((db) => db.user.findFirst({ where: { referralCode: referralCode.trim(), role: "RESELLER" }, select: { id: true } }))
    .catch(() => null);
  return reseller?.id;
}

/** E.164-normalise a mobile for storage/comparison; falls back to the trimmed
 *  input when it can't be parsed (the register schema already rejects invalid). */
function normalizeMobile(mobile: string): string {
  return parsePhoneNumberFromString(mobile.trim())?.number ?? mobile.trim();
}

/** One account per mobile (mirrors one-card-per-account). 409 if taken; no-op when blank. */
async function assertMobileAvailable(mobile?: string): Promise<void> {
  const raw = mobile?.trim();
  if (!raw) return;
  const door = currentBrandId();
  const existing = door
    ? await tenantFor(door)
        .then((db) => db.profile.findFirst({ where: { mobile: normalizeMobile(raw) }, select: { id: true } }))
        .catch(() => null)
    : null;
  if (existing) {
    throw new HttpError(
      409,
      "This mobile number is already registered. Please use a different number or log in.",
    );
  }
}

/** Create a fresh user with the default profile/agent/crm records, then a session token. */
async function createUser(data: {
  email: string;
  passwordHash: string;
  fullName: string;
  businessName: string;
  mobile?: string;
  businessNumber?: string;
  address?: string;
  referralCode?: string;
  viaOnboarding?: boolean;
  timezone?: string;
  /** Card-required policy frozen at /register/start so the OTP window can't change it. Direct /register omits it and reads live. */
  cardRequired?: boolean;
}) {
  // One account per mobile — re-checked here (not just at /register/start) so a
  // race between two pending sign-ups can't create two accounts on one number.
  await assertMobileAvailable(data.mobile);
  const referredById = await resolveReferrer(data.referralCode);
  // Freeze the card policy onto the row — the ONLY read of it for a customer; every downstream gate uses
  // the stamped column, so flipping the admin toggle never retroactively walls a live account.
  const signupBrand = cachedBrand(currentBrandId());
  const cardRequired = data.cardRequired ?? (await getOnboardingCardRequired());
  // A fresh profile stays subscriptionStatus="none": the free trial (card-less), or "no card yet" (card-required).
  const signupBusiness = data.businessName?.trim() || "";
  // Best guess from phone/address/browser so accounts don't all start life in Sydney; the owner overrides in Rules.
  const signupTimeZone = resolveBusinessTimeZone({
    businessNumber: data.businessNumber,
    mobile: data.mobile,
    address: data.address,
    browserTimeZone: data.timezone,
    fallbackTimeZone: signupBrand?.defaultTimezone,
  });
  const agentConfig = {
    ...DEFAULT_AGENT_CONFIG,
    identity: {
      ...DEFAULT_AGENT_CONFIG.identity,
      // Brand defaults for its customers; the owner can still change both in the AI Brain.
      ...(signupBrand?.defaultVoiceId ? { voiceId: signupBrand.defaultVoiceId } : {}),
      ...(signupBrand?.defaultCountry ? { country: signupBrand.defaultCountry } : {}),
      businessName: signupBusiness,
      assistantName: signupBusiness
        ? `${signupBusiness} Receptionist`
        : DEFAULT_AGENT_CONFIG.identity.assistantName,
    },
    rules: { ...DEFAULT_AGENT_CONFIG.rules, timezone: signupTimeZone },
  };
  // Guided-onboarding sign-ups resume at step 5 (Services) after verification;
  // direct sign-ups skip the funnel and are marked complete immediately.
  const onboarding = data.viaOnboarding
    ? { onboardingStep: 5 }
    : { onboardingStep: 0, onboardingCompletedAt: new Date() };
  // Resolved once so the user row and membership row get the same brand. Never null: assertSignupOpen()
  // refuses the platform door, and the DB refuses a USER row without a brand anyway.
  const { brandId: signupBrandId, db } = await signupTenant();
  const user = await db.user.create({
    data: {
      email: data.email,
      passwordHash: data.passwordHash,
      fullName: data.fullName,
      role: "USER",
      referredById,
      profile: {
        create: {
          businessName: data.businessName,
          receptionistNumber: "",
          ...(data.mobile?.trim() ? { mobile: normalizeMobile(data.mobile) } : {}),
          ...(data.businessNumber?.trim() ? { businessNumber: data.businessNumber.trim() } : {}),
          ...(data.address?.trim() ? { address: data.address.trim() } : {}),
          ...(isValidTimeZone(data.timezone) ? { timezone: data.timezone!.trim() } : {}),
          ...onboarding,
          cardRequiredAtSignup: cardRequired,
        },
      },
      conversion: {
        create: {
          agentConfig: agentConfig as object,
          dataCaptureFields: DEFAULT_AGENT_CONFIG.knowledge.captureFields as object,
        },
      },
    },
    include: { profile: true },
  });
  // The CRM row hangs off the account by id (no relation), so it is its own write.
  await db.crmIntegration.create({ data: { userId: user.id } });
  // Self-serve: a new signup provisions automatically once they add a plan +
  // claim a number — no admin approval needed. Notify admins for visibility only.
  void notifyAdminsOfSignup({
    fullName: user.fullName,
    email: user.email,
    businessName: data.businessName,
    mobile: data.mobile,
    businessNumber: data.businessNumber,
    address: data.address,
    referralCode: data.referralCode,
    timezone: data.timezone,
  }).catch(() => {});
  void notifyBrandAdmins({
    type: "system",
    title: `New signup: ${data.businessName?.trim() || user.fullName}`,
    message: `${user.fullName} just signed up and started their free trial.`,
    link: "/dashboard/admin/customers",
  });
  void notify(user.id, {
    type: "agent",
    title: `Welcome to ${brandDisplayName(signupBrandId)}`,
    message: "Your dashboard is ready. Explore the AI Brain to customize your assistant.",
    link: "/dashboard/assistant",
  });
  // If they came through a reseller's referral link, email + notify that reseller.
  if (referredById) {
    void notifyReferrerOfSignup(referredById, {
      fullName: user.fullName,
      email: user.email,
      businessName: data.businessName,
      mobile: data.mobile,
      businessNumber: data.businessNumber,
      address: data.address,
    }).catch(() => {});
  }
  const token = signToken({
    sub: user.id,
    email: user.email,
    role: user.role,
    permissions: user.permissions ?? [],
    brandId: signupBrandId,
  });
  return {
    token,
    user: {
      ...user,
      brandId: signupBrandId,
      brand: signupBrand ? { name: signupBrand.name, slug: signupBrand.slug } : null,
    },
  };
}

// Strong-password policy — mirrored on the client (src/pages/auth/authSchemas.ts)
// so a weak password can't slip through by calling the API directly.
const strongPassword = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(40, "Password must be at most 40 characters")
  .regex(/[a-z]/, "Password must include a lowercase letter")
  .regex(/[A-Z]/, "Password must include an uppercase letter")
  .regex(/[^A-Za-z0-9]/, "Password must include a special character");

const registerSchema = z.object({
  email: z.string().email(),
  password: strongPassword,
  // Always store a person's name title-cased ("redtape" -> "Redtape") so it
  // reads correctly everywhere it's displayed.
  fullName: z.string().min(1).transform(titleCaseName),
  // Clamp to 40 (Vapi's assistant-name limit) instead of rejecting, so signup
  // never fails on a long scraped business name.
  businessName: z.string().transform(clampName).optional(),
  // Mirrors the client E.164 check so a direct API call can't slip a malformed number through. Blank stays allowed.
  mobile: z
    .string()
    .optional()
    .refine((v) => !v?.trim() || isValidPhoneNumber(v.trim()), "Enter a valid phone number"),
  businessNumber: z.string().optional(),
  address: z.string().optional(),
  referralCode: z.string().optional(),
  viaOnboarding: z.boolean().optional(),
  // Browser IANA timezone. Junk is dropped, not rejected — signup must not fail on it.
  timezone: z
    .string()
    .optional()
    .transform((v) => (isValidTimeZone(v) ? v!.trim() : undefined)),
});

// Per-IP limiter shared by register/login/OTP. Several users can share one office NAT, so leave
// headroom for honest retries while still killing brute force.
const authLimiter = rateLimit({ windowMs: 60_000, max: 30 });

/** Refuses self-serve sign-up on an invite-only brand and on the platform door. Runs before body parsing so it leaks no validation hints. */
function assertSignupOpen(): void {
  const brand = cachedBrand(currentBrandId());
  if (brandAllowsSignup(brand)) return;
  throw new HttpError(
    403,
    brand
      ? `${brand.name} accounts are set up by its team — contact them for access.`
      : "Accounts are created on your provider's own website — sign up there.",
    "signup_closed",
  );
}

router.post(
  "/register",
  authLimiter,
  asyncHandler(async (req, res) => {
    assertSignupOpen();
    const { email, password, fullName, businessName, mobile, businessNumber, address, referralCode, viaOnboarding, timezone } =
      registerSchema.parse(req.body);

    const { db } = await signupTenant();
    const existing = await db.user.findUnique({ where: { email } });
    if (existing) throw new HttpError(409, "Email already registered");
    await assertMobileAvailable(mobile);

    const passwordHash = await hashPassword(password);
    const { token, user } = await createUser({
      email,
      passwordHash,
      fullName,
      businessName: businessName ?? "",
      mobile,
      businessNumber,
      address,
      referralCode,
      viaOnboarding,
      timezone,
    });
    res.json({ token, user: serializeUser(user) });
  }),
);

// Step 1 of sign-up: validate, stash the (hashed) details on an OTP, email the code.
// The user is not created until the code is verified.
router.post(
  "/register/start",
  authLimiter,
  asyncHandler(async (req, res) => {
    assertSignupOpen();
    const { email, password, fullName, businessName, mobile, businessNumber, address, referralCode, viaOnboarding, timezone } =
      registerSchema.parse(req.body);

    const { db } = await signupTenant();
    const existing = await db.user.findUnique({ where: { email } });
    if (existing) throw new HttpError(409, "Email already registered");
    await assertMobileAvailable(mobile);

    const passwordHash = await hashPassword(password);
    const payload: SignupPayload = {
      passwordHash,
      fullName,
      businessName: businessName ?? "",
      mobile,
      businessNumber,
      address,
      referralCode,
      viaOnboarding,
      timezone,
      // Frozen now so an admin flipping the toggle during the OTP window can't
      // stamp this account with a policy the user was never shown.
      cardRequired: await getOnboardingCardRequired(),
    };
    const code = await createOtp({ email, purpose: "signup", payload });
    await sendOtpEmail(email, code, "signup");
    // Also text the same code to the owner's mobile (best-effort — never blocks signup).
    await sendOtpSms(mobile, code, "signup");

    res.json({ ok: true, email });
  }),
);

const otpVerifySchema = z.object({
  email: z.string().email(),
  code: z.string().min(4),
});

// Step 2 of sign-up: verify the code and create the account from the pending payload.
router.post(
  "/register/verify",
  asyncHandler(async (req, res) => {
    const { email, code } = otpVerifySchema.parse(req.body);

    const { brandId: door, db } = await signupTenant();
    const existing = await db.user.findUnique({ where: { email }, include: { profile: true } });
    if (existing) {
      // Recovery: a prior verify created the account but the response was lost. Same code → re-issue the session, don't 409.
      if (!(await signupCodeMatches(email, code))) {
        throw new HttpError(409, "Email already registered");
      }
      const token = signToken({
        sub: existing.id,
        email: existing.email,
        role: existing.role,
        permissions: existing.permissions ?? [],
        brandId: door,
      });
      res.json({ token, user: serializeUser({ ...existing, brandId: door }) });
      return;
    }

    const row = await consumeOtp(email, "signup", code);
    const payload = row.payload as SignupPayload | null;
    if (!payload) throw badRequest("Sign-up details expired. Please sign up again.");

    const { token, user } = await createUser({ email, ...payload });
    res.json({ token, user: serializeUser(user) });
  }),
);

const emailOnlySchema = z.object({ email: z.string().email() });

// Re-issue a sign-up code, reusing the pending details from the prior code.
router.post(
  "/register/resend",
  asyncHandler(async (req, res) => {
    const { email } = emailOnlySchema.parse(req.body);
    const payload = await pendingSignupPayload(email);
    if (!payload) {
      // No pending code: if the account already exists, the sign-up finished —
      // point them to logging in rather than restarting.
      const existing = await findAccountOnThisDoor(email).catch(() => null);
      throw badRequest(
        existing
          ? "This email is already registered. Please log in instead."
          : "No pending sign-up found. Please start again.",
      );
    }
    const code = await createOtp({ email, purpose: "signup", payload });
    await sendOtpEmail(email, code, "signup");
    // Re-send to the mobile captured on the pending sign-up too (best-effort).
    await sendOtpSms(payload.mobile, code, "signup");
    res.json({ ok: true });
  }),
);

// Reset step 1: email a code. Unknown email gets a clear error — UX clarity over hiding which emails exist.
router.post(
  "/forgot-password",
  authLimiter,
  asyncHandler(async (req, res) => {
    const { email } = emailOnlySchema.parse(req.body);
    // Door-scoped, like sign-in: a brand's door resets its own people's
    // passwords, and an account from another door is told where it lives.
    const account = await findAccountOnThisDoor(email);
    if (!account) throw notFound("No account found with that email address.");
    const code = await createOtp({ email, purpose: "password_reset" });
    await sendOtpEmail(email, code, "password_reset");
    res.json({ ok: true });
  }),
);

const resetSchema = z.object({
  email: z.string().email(),
  code: z.string().min(4),
  newPassword: z.string().min(8).max(40, "Password must be at most 40 characters"),
});

// Step 2 of reset: verify the code, set the new password, and sign the user in.
router.post(
  "/reset-password",
  authLimiter,
  asyncHandler(async (req, res) => {
    const { email, code, newPassword } = resetSchema.parse(req.body);

    await consumeOtp(email, "password_reset", code);

    const account = await findAccountOnThisDoor(email);
    if (!account) throw notFound("User not found");

    const passwordHash = await hashPassword(newPassword);
    // Written to the control plane; the identity mirror carries it into the
    // brand's database in the same call, so the next sign-in sees it.
    await (await planeOf(account.brandId)).user.update({ where: { id: account.id }, data: { passwordHash } });
    const user = await loadAccount(account.id, account.brandId);
    if (!user) throw notFound("User not found");

    const token = signToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      permissions: user.permissions ?? [],
      brandId: account.brandId,
    });
    res.json({ token, user: serializeUser(user) });
  }),
);

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

router.post(
  "/login",
  authLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);

    // Identity and password are answered by the door's own database.
    const account = await findAccountOnThisDoor(email);
    if (!account || !(await verifyPassword(password, account.passwordHash))) {
      throw unauthorized("Invalid email or password");
    }
    const user = await loadAccount(account.id, account.brandId);
    if (!user) throw unauthorized("Invalid email or password");

    // A switched-off brand's people can't sign in anywhere — otherwise they'd keep working via the platform domain.
    if (user.brand?.status === "suspended" || user.brand?.status === "deactivated") {
      throw new HttpError(403, brandOfflineMessage(user.brand.status), "account_suspended");
    }
    // A brand still being set up has no database to serve its people from yet.
    if (user.brand && user.brand.status !== "active") {
      throw new HttpError(403, "This brand is still being set up. Try again shortly.", "brand_not_ready");
    }

    // An admin-suspended account is locked out entirely — block login and tell the
    // user clearly (not a generic credentials error) so they know to reach support.
    if (user.profile?.suspendedAt) {
      throw new HttpError(
        403,
        "Your account has been suspended. Please contact support if you think this is a mistake.",
        "account_suspended",
      );
    }

    const token = signToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      permissions: user.permissions ?? [],
      // Which database this session is read from, on every request after this.
      brandId: account.brandId,
    });
    res.json({ token, user: serializeUser(await withStaffRole(user)) });
  }),
);

router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    // Reconcile with Stripe first so an ended trial that auto-charged shows as active. Platform people have no subscription.
    if (req.user!.brandId) await reconcileSubscription(req.user!.sub);
    const user = await loadAccount(req.user!.sub, req.user!.brandId ?? null);
    if (!user) throw unauthorized("Your session is no longer valid");
    // Suspended mid-session: the frontend treats this code as a hard logout.
    if (user.profile?.suspendedAt) {
      throw new HttpError(403, "Your account has been suspended.", "account_suspended");
    }
    // Same, one level up: the whole brand was switched off while they were working.
    if (user.brand?.status === "suspended" || user.brand?.status === "deactivated") {
      throw new HttpError(403, brandOfflineMessage(user.brand.status), "account_suspended");
    }
    if (user.brand && user.brand.status !== "active") {
      throw new HttpError(403, "This brand is still being set up.", "brand_not_ready");
    }
    res.json({ user: serializeUser(await withStaffRole(user)) });
  }),
);

const changePasswordSchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(8).max(40, "Password must be at most 40 characters"),
});

router.post(
  "/change-password",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);

    const db = await planeOf(req.user!.brandId ?? null);
    const user = await db.user.findUnique({ where: { id: req.user!.sub } });
    if (!user) throw notFound("User not found");
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw badRequest("Current password is incorrect");
    }
    const passwordHash = await hashPassword(newPassword);
    await db.user.update({ where: { id: user.id }, data: { passwordHash } });

    res.json({ ok: true });
  }),
);

export default router;
