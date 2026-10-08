import type { BrandRequest } from "@prisma/client";
import { prisma } from "../prisma.js";
import { badRequest, notFound } from "../lib/http.js";
import { normalizeSlug, slugProblem } from "../lib/brandTheme.js";
import { platformSubdomainHost, platformSubdomainUrl } from "../env.js";
import { sendTemplate } from "./email.js";
import { notifyPlatformOwners } from "./notifications.js";
import { assertDomainAvailable, resolveTheme } from "./brands.js";
import { deleteObject, isStorageConfigured, uploadObject } from "./storage.js";
import { isStripeConfigured, stripe } from "./stripe.js";

// Brand requests: a main-domain customer asks, from inside their dashboard, for their account to become a brand
// (fileBrandAdminRequest); a super admin completes setup and the same account becomes the Brand Admin
// (services/brandLifecycle.ts). See the BrandRequest model.

/** Statuses a request can hold (the column is plain text). */
export type BrandRequestStatus = "pending" | "approving" | "awaiting_domain" | "approved" | "declined";

/** An `approving` claim older than this is treated as abandoned (the operator's
 *  request died mid-create) and may be claimed again. */
const CLAIM_STALE_MS = 10 * 60 * 1000;

/** Still being worked on — the statuses that block a second request (and hold the subdomain asked for). */
const OPEN_STATUSES = ["pending", "approving", "awaiting_domain"];

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
  contactName: string;
  email: string;
  phone: string;
  country: string;
  timezone: string;
  notes: string;
  /** The main-domain account that asked (its own row), when filed from inside the app; null for the old public form. */
  applicantBrandId: string | null;
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
    contactName: r.contactName,
    email: r.email,
    phone: r.phone,
    country: r.country,
    timezone: r.timezone,
    notes: r.notes,
    applicantBrandId: r.applicantBrandId,
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

/** Storage key of a public object URL (everything after the host). */
function keyOf(url: string): string {
  return url ? url.split("/").slice(3).join("/") : "";
}

/** Best-effort removal of a request's uploaded logos. */
async function deleteLogos(urls: string[]): Promise<void> {
  await Promise.all(urls.filter(Boolean).map((u) => deleteObject(keyOf(u)).catch(() => undefined)));
}

/** What a main-domain customer fills in to ask to become a Brand Admin. Who they are comes from their account. */
export interface BrandAdminRequestInput {
  brandName: string;
  slug: string;
  tagline?: string;
  customDomain?: string;
  themePreset?: string;
  primaryColor?: string;
  accentColor?: string;
  fontFamily?: string;
  phone?: string;
  notes?: string;
}

/** Files a Brand Admin request from inside a main-domain customer's dashboard. Tied to their own row and account,
 *  so approval turns THAT account into the brand — no password, plan or card is collected here. */
export async function fileBrandAdminRequest(
  applicant: { brandId: string; userId: string; email: string; fullName: string; country?: string; timezone?: string },
  input: BrandAdminRequestInput,
  logos: Partial<Record<RequestLogoSlot, RequestUpload>> = {},
): Promise<BrandRequest> {
  const open = await prisma.brandRequest.findFirst({
    where: { applicantBrandId: applicant.brandId, status: { in: ["pending", "approving", "awaiting_domain"] } },
    select: { brandName: true },
  });
  if (open) throw badRequest(`Your request for ${open.brandName} is already in review.`);

  const slug = normalizeSlug(input.slug || input.brandName);
  const problem = await requestSlugProblem(slug);
  if (problem) throw badRequest(problem);
  const customDomain = (await assertDomainAvailable(input.customDomain, applicant.brandId)) ?? "";

  const picked = input.themePreset || input.primaryColor || input.accentColor || input.fontFamily;
  const theme = picked
    ? resolveTheme({
        themePreset: input.themePreset,
        primaryColor: input.primaryColor,
        accentColor: input.accentColor,
        fontFamily: input.fontFamily,
      })
    : null;

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
        applicantBrandId: applicant.brandId,
        applicantUserId: applicant.userId,
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
        contactName: applicant.fullName.trim() || applicant.email,
        email: applicant.email.trim().toLowerCase(),
        phone: (input.phone ?? "").trim(),
        country: (applicant.country ?? "").trim().toUpperCase().slice(0, 2),
        timezone: (applicant.timezone ?? "").trim(),
        notes: (input.notes ?? "").trim(),
      },
    });
  } catch (e) {
    await deleteLogos(Object.values(urls));
    throw e;
  }

  try {
    await sendTemplate("brand_request_received", request.email, {
      user_name: request.contactName,
      brand_name: request.brandName,
      brand_host: (customDomain || platformSubdomainUrl(slug)).replace(/^https?:\/\//, ""),
    });
  } catch {
    /* the super admin still sees the request */
  }
  void notifyPlatformOwners({
    type: "system",
    title: "New Brand Admin request",
    message: `${request.contactName} (${request.email}) wants to launch ${request.brandName}.`,
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
