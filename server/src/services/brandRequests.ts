import type { BrandRequest } from "@prisma/client";
import { prisma } from "../prisma.js";
import { badRequest, notFound } from "../lib/http.js";
import { hashPassword } from "../lib/password.js";
import { normalizeSlug, slugProblem } from "../lib/brandTheme.js";
import { platformSubdomainHost, platformSubdomainUrl } from "../env.js";
import { sendTemplate } from "./email.js";
import { notifyAdmins } from "./notifications.js";
import { assertDomainAvailable, resolveTheme } from "./brands.js";
import { deleteObject, isStorageConfigured, uploadObject } from "./storage.js";
import { isStripeConfigured, stripe } from "./stripe.js";

// Brand requests: a prospective brand files its basics from the public "Set up
// your brand" page; a super admin completes setup (look, settings, permissions)
// and only then is anything created. See the BrandRequest model.

/** Statuses a request can hold (the column is plain text). */
export type BrandRequestStatus = "pending" | "approving" | "approved" | "declined";

/** An `approving` claim older than this is treated as abandoned (the operator's
 *  request died mid-create) and may be claimed again. */
const CLAIM_STALE_MS = 10 * 60 * 1000;

/** Still waiting on a super admin — the statuses that block a second request. */
const OPEN_STATUSES = ["pending", "approving"];

export interface BrandRequestView {
  id: string;
  status: BrandRequestStatus;
  brandName: string;
  slug: string;
  tagline: string;
  /** The applicant's own domain, "" when none. */
  customDomain: string;
  /** The look they picked; "" = not chosen. */
  themePreset: string;
  primaryColor: string;
  accentColor: string;
  fontFamily: string;
  /** Logos they uploaded; "" = none. */
  logoLightUrl: string;
  logoDarkUrl: string;
  faviconUrl: string;
  /** The brand plan they chose; "" = none. */
  brandPlanId: string;
  /** The card they saved (charged only at setup); null = none. */
  card: { brand: string; last4: string } | null;
  contactName: string;
  email: string;
  phone: string;
  country: string;
  timezone: string;
  notes: string;
  brandId: string | null;
  reviewedAt: string | null;
  declineReason: string;
  createdAt: string;
}

/** What the super admin sees. Never the password hash. */
export function serializeBrandRequest(r: BrandRequest): BrandRequestView {
  return {
    id: r.id,
    status: r.status as BrandRequestStatus,
    brandName: r.brandName,
    slug: r.slug,
    tagline: r.tagline,
    customDomain: r.customDomain,
    themePreset: r.themePreset,
    primaryColor: r.primaryColor,
    accentColor: r.accentColor,
    fontFamily: r.fontFamily,
    logoLightUrl: r.logoLightUrl,
    logoDarkUrl: r.logoDarkUrl,
    faviconUrl: r.faviconUrl,
    brandPlanId: r.brandPlanId,
    card: r.paymentMethodId ? { brand: r.cardBrand, last4: r.cardLast4 } : null,
    contactName: r.contactName,
    email: r.email,
    phone: r.phone,
    country: r.country,
    timezone: r.timezone,
    notes: r.notes,
    brandId: r.brandId,
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    declineReason: r.declineReason,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Why `slug` can't be asked for, or null. Taken by a live brand or by another
 *  open request both count — two applicants racing for one address would leave
 *  the super admin to disappoint one of them. */
export async function requestSlugProblem(slug: string, exceptRequestId?: string): Promise<string | null> {
  const problem = slugProblem(slug);
  if (problem) return problem;
  const [brand, request] = await Promise.all([
    prisma.brand.findUnique({ where: { slug }, select: { id: true } }),
    prisma.brandRequest.findFirst({
      where: { slug, status: { in: OPEN_STATUSES }, ...(exceptRequestId ? { id: { not: exceptRequestId } } : {}) },
      select: { id: true },
    }),
  ]);
  if (brand) return `The address "${slug}" is already taken.`;
  if (request) return `Someone has already asked for "${slug}". Pick another address.`;
  return null;
}

/** Public availability probe for the request form. `suffix` (".hello22.ai") is
 *  always there, so the field can show it before anything valid is typed. */
export async function checkRequestSlug(raw: string) {
  const slug = normalizeSlug(raw);
  const reason = await requestSlugProblem(slug);
  return {
    slug,
    available: !reason,
    reason: reason ?? "",
    url: reason ? "" : platformSubdomainUrl(slug),
    suffix: platformSubdomainHost("x").slice(1),
  };
}

export interface BrandRequestInput {
  brandName: string;
  slug: string;
  tagline?: string;
  customDomain?: string;
  /** A palette + typeface from the brand catalog. Sent together or not at all. */
  themePreset?: string;
  primaryColor?: string;
  accentColor?: string;
  fontFamily?: string;
  /** The brand plan chosen. Required while any plan is on offer. */
  brandPlanId?: string;
  /** A confirmed SetupIntent from createRequestSetupIntent — the saved card. */
  setupIntentId?: string;
  contactName: string;
  email: string;
  phone?: string;
  country?: string;
  timezone?: string;
  notes?: string;
  password: string;
}

/** An uploaded file, as multer hands it over. */
export interface RequestUpload {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
}

/** The logo slots a request can carry, and the column + storage prefix of each. */
export const REQUEST_LOGO_SLOTS = {
  logoLight: { column: "logoLightUrl", prefix: "brand-requests/logo-light" },
  logoDark: { column: "logoDarkUrl", prefix: "brand-requests/logo-dark" },
  favicon: { column: "faviconUrl", prefix: "brand-requests/favicon" },
} as const;
export type RequestLogoSlot = keyof typeof REQUEST_LOGO_SLOTS;

/** The payment step's card form: a Stripe customer for the applicant and a SetupIntent on it. The card is
 *  saved, not charged — the first month is charged when a super admin completes the setup. */
export async function createRequestSetupIntent(input: { email: string; name: string }) {
  if (!isStripeConfigured()) throw badRequest("Card payments aren't available right now.");
  const customer = await stripe().customers.create({
    email: input.email.trim().toLowerCase(),
    name: input.name.trim(),
    metadata: { kind: "brand_request" },
  });
  const intent = await stripe().setupIntents.create({
    customer: customer.id,
    usage: "off_session",
    payment_method_types: ["card"],
    metadata: { kind: "brand_request" },
  });
  if (!intent.client_secret) throw new Error("Stripe returned no client secret");
  return { clientSecret: intent.client_secret, setupIntentId: intent.id };
}

/** A confirmed SetupIntent's customer and card — read from Stripe, never from the browser. */
async function savedCard(setupIntentId: string, contact: { email: string; name: string }) {
  let intent;
  try {
    intent = await stripe().setupIntents.retrieve(setupIntentId, { expand: ["payment_method"] });
  } catch {
    throw badRequest("We couldn't find that card. Please add it again.");
  }
  const customerId = typeof intent.customer === "string" ? intent.customer : intent.customer?.id;
  const pm = intent.payment_method;
  if (intent.status !== "succeeded" || !customerId || !pm || typeof pm === "string") {
    throw badRequest("That card wasn't confirmed. Please add it again.");
  }
  if (intent.metadata?.kind !== "brand_request") throw badRequest("That card can't be used here.");
  // The contact may have changed after the card step; the customer should say who it is now.
  await stripe()
    .customers.update(customerId, { email: contact.email, name: contact.name })
    .catch(() => undefined);
  return {
    stripeCustomerId: customerId,
    paymentMethodId: pm.id,
    cardBrand: pm.card?.brand ?? "",
    cardLast4: pm.card?.last4 ?? "",
  };
}

/** Storage key of a public object URL (everything after the host). */
function keyOf(url: string): string {
  return url ? url.split("/").slice(3).join("/") : "";
}

/** Best-effort removal of a request's uploaded logos. */
async function deleteLogos(urls: string[]): Promise<void> {
  await Promise.all(urls.filter(Boolean).map((u) => deleteObject(keyOf(u)).catch(() => undefined)));
}

/** Files a request. Nothing else is created: the brand, its database and its
 *  admin all wait for a super admin. Logos are stored only once everything else
 *  has passed, so a refused request leaves no files behind. */
export async function fileBrandRequest(
  input: BrandRequestInput,
  logos: Partial<Record<RequestLogoSlot, RequestUpload>> = {},
): Promise<BrandRequest> {
  const email = input.email.trim().toLowerCase();
  const slug = normalizeSlug(input.slug || input.brandName);
  const problem = await requestSlugProblem(slug);
  if (problem) throw badRequest(problem);

  const open = await prisma.brandRequest.findFirst({
    where: { email, status: { in: OPEN_STATUSES } },
    select: { brandName: true },
  });
  if (open) {
    throw badRequest(
      `${email} already has a request in review (${open.brandName}). We'll email you as soon as it's set up.`,
    );
  }

  // Checked now so a typo or a domain another brand holds is fixed by the one
  // person who knows the answer. Nothing is claimed until setup.
  const customDomain = (await assertDomainAvailable(input.customDomain)) ?? "";

  // Same rules as a brand's own theme (catalog preset + font, hex colours), so
  // whatever was picked here saves unchanged at setup.
  const picked = input.themePreset || input.primaryColor || input.accentColor || input.fontFamily;
  const theme = picked
    ? resolveTheme({
        themePreset: input.themePreset,
        primaryColor: input.primaryColor,
        accentColor: input.accentColor,
        fontFamily: input.fontFamily,
      })
    : null;

  // The plan: required while any is on offer, and it must be one that is.
  const offered = await prisma.brandPlan.findMany({ where: { active: true }, select: { id: true } });
  const brandPlanId = (input.brandPlanId ?? "").trim();
  if (offered.length && !brandPlanId) throw badRequest("Choose a plan for your brand.");
  if (brandPlanId && !offered.some((p) => p.id === brandPlanId)) {
    throw badRequest("That plan isn't available any more. Please choose another.");
  }

  // The card is optional here: without one, the brand's admin pays at first sign-in instead.
  const card =
    input.setupIntentId && isStripeConfigured()
      ? await savedCard(input.setupIntentId, { email, name: input.contactName.trim() })
      : null;

  const passwordHash = await hashPassword(input.password);

  const slots = (Object.keys(REQUEST_LOGO_SLOTS) as RequestLogoSlot[]).filter((s) => logos[s]);
  if (slots.length && !isStorageConfigured()) {
    throw badRequest("Logo uploads aren't available right now — send the request without them.");
  }
  const urls: Partial<Record<(typeof REQUEST_LOGO_SLOTS)[RequestLogoSlot]["column"], string>> = {};
  try {
    for (const slot of slots) {
      const file = logos[slot]!;
      const def = REQUEST_LOGO_SLOTS[slot];
      urls[def.column] = (await uploadObject(`${def.prefix}/${slug}`, file.buffer, file.mimetype, file.originalname)).url;
    }
  } catch (e) {
    await deleteLogos(Object.values(urls));
    throw e;
  }

  let request: BrandRequest;
  try {
    request = await prisma.brandRequest.create({
      data: {
        brandName: input.brandName.trim(),
        slug,
        tagline: (input.tagline ?? "").trim(),
        customDomain,
        ...(theme
          ? {
              themePreset: theme.themePreset,
              primaryColor: theme.primaryColor,
              accentColor: theme.accentColor,
              fontFamily: theme.fontFamily,
            }
          : {}),
        ...urls,
        brandPlanId,
        ...(card ?? {}),
        contactName: input.contactName.trim(),
        email,
        phone: (input.phone ?? "").trim(),
        country: (input.country ?? "").trim().toUpperCase(),
        timezone: (input.timezone ?? "").trim(),
        notes: (input.notes ?? "").trim(),
        passwordHash,
      },
    });
  } catch (e) {
    // The row never landed — its files would be orphans.
    await deleteLogos(Object.values(urls));
    throw e;
  }

  // Both best-effort: the request is filed either way.
  try {
    await sendTemplate("brand_request_received", email, {
      user_name: request.contactName,
      brand_name: request.brandName,
      brand_host: platformSubdomainUrl(slug).replace(/^https?:\/\//, ""),
    });
  } catch {
    /* the super admin still sees the request */
  }
  void notifyAdmins({
    type: "system",
    title: "New brand request",
    message: `${request.brandName} (${request.email}) is waiting for setup.`,
    link: "/dashboard/admin/brands?tab=requests",
  });

  return request;
}

/** A request, or 404. */
export async function brandRequestOr404(id: string): Promise<BrandRequest> {
  const request = await prisma.brandRequest.findUnique({ where: { id } });
  if (!request) throw notFound("Brand request not found");
  return request;
}

/** Why a request can't be acted on, or null when it is still open. */
function closedReason(r: BrandRequest): string | null {
  if (r.status === "approved") return "This request has already been set up.";
  if (r.status === "declined") return "This request was declined.";
  if (r.status === "approving" && Date.now() - r.updatedAt.getTime() < CLAIM_STALE_MS) {
    return "Another admin is completing this setup right now.";
  }
  return null;
}

/** Marks the request `approving` so a second "Complete setup" can't create a
 *  second brand. Atomic: only one caller's update matches. */
export async function claimBrandRequest(id: string, actorId: string): Promise<BrandRequest> {
  const staleBefore = new Date(Date.now() - CLAIM_STALE_MS);
  const { count } = await prisma.brandRequest.updateMany({
    where: {
      id,
      OR: [{ status: "pending" }, { status: "approving", updatedAt: { lt: staleBefore } }],
    },
    data: { status: "approving", reviewedById: actorId },
  });
  const request = await brandRequestOr404(id);
  if (count === 0) throw badRequest(closedReason(request) ?? "This request can't be set up right now.");
  return request;
}

/** Hands a claim back when creating the brand failed, so the setup can be retried. */
export async function releaseBrandRequest(id: string): Promise<void> {
  await prisma.brandRequest.updateMany({ where: { id, status: "approving" }, data: { status: "pending" } });
}

/** The brand exists: link it and drop the password hash, which has done its job. */
export async function completeBrandRequest(id: string, brandId: string, actorId: string): Promise<BrandRequest> {
  return prisma.brandRequest.update({
    where: { id },
    data: { status: "approved", brandId, reviewedById: actorId, reviewedAt: new Date(), passwordHash: "" },
  });
}

export async function declineBrandRequest(
  id: string,
  opts: { reason: string; actorId: string; notify: boolean },
): Promise<BrandRequest> {
  const existing = await brandRequestOr404(id);
  const closed = closedReason(existing);
  if (closed) throw badRequest(closed);
  const request = await prisma.brandRequest.update({
    where: { id },
    data: {
      status: "declined",
      declineReason: opts.reason.trim(),
      reviewedById: opts.actorId,
      reviewedAt: new Date(),
      passwordHash: "",
      // Nothing will ever use them now.
      logoLightUrl: "",
      logoDarkUrl: "",
      faviconUrl: "",
      stripeCustomerId: "",
      paymentMethodId: "",
    },
  });
  await deleteLogos([existing.logoLightUrl, existing.logoDarkUrl, existing.faviconUrl]);
  // The card was only ever saved, never charged — delete the customer so nothing of theirs stays on file.
  if (existing.stripeCustomerId && isStripeConfigured()) {
    await stripe().customers.del(existing.stripeCustomerId).catch(() => undefined);
  }
  if (opts.notify) {
    try {
      await sendTemplate("brand_request_declined", request.email, {
        user_name: request.contactName,
        brand_name: request.brandName,
        reason: request.declineReason,
      });
    } catch {
      /* declined either way */
    }
  }
  return request;
}
