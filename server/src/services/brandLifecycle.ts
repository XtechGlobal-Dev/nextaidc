import type { Brand, BrandRequest } from "@prisma/client";
import { prisma } from "../prisma.js";
import { badRequest } from "../lib/http.js";
import { appBaseUrl } from "../env.js";
import { brandOrigin, cachedBrand, isCustomerBrand, refreshBrand, updateBrand, type BrandInput } from "./brands.js";
import { tenantFor } from "./tenantDb.js";
import { sendTemplate } from "./email.js";
import { notify } from "./notifications.js";
import { publishToUser } from "./events.js";
import { audit } from "./audit.js";
import { customerSlugFor } from "./platformCustomers.js";

// Customer → Brand Admin → customer (docs/brand-as-customer-plan.md). The account, its database and its brand row
// never change: only the row's kind, its door (slug / own domain) and the owner's role move. So the owner keeps
// their assistant, number, calls, plan and password through every step, and a downgraded brand's customers are
// kept (closed, not deleted) in case the brand comes back.

/** A request still being worked on — at most one per account. */
export const OPEN_ADMIN_REQUEST_STATUSES = ["pending", "approving", "awaiting_domain"];

/** Subscription states that let a customer ask to become a brand: a plan they pay for, or a trial. */
const REQUEST_ELIGIBLE_STATUSES = ["active", "past_due", "trialing"];

/** The customer-state row behind a main-domain account, checked to really be theirs. */
export function ownedCustomerRow(brandId: string | null | undefined, userId: string): Brand {
  const row = cachedBrand(brandId);
  if (!row || !isCustomerBrand(row) || row.status !== "active" || row.ownerUserId !== userId) {
    throw badRequest("Only a main-domain customer's own account can ask to become a Brand Admin.");
  }
  return row;
}

/** Why this account can't ask yet, or null. A brand is a paying customer first (the same plans as everyone). */
export async function requestEligibilityProblem(brandId: string, userId: string): Promise<string | null> {
  const db = await tenantFor(brandId);
  const profile = await db.profile.findUnique({
    where: { userId },
    select: { subscriptionStatus: true, trialStartedAt: true, trialStatus: true },
  });
  const onTrial = !!profile?.trialStartedAt && profile.trialStatus === "active";
  if (profile && (REQUEST_ELIGIBLE_STATUSES.includes(profile.subscriptionStatus) || onTrial)) return null;
  return "Choose a plan (or start your trial) first — a brand runs on the same plans as every customer.";
}

/** The account's newest request, open or not — what its dashboard card shows. */
export async function latestAdminRequest(brandId: string): Promise<BrandRequest | null> {
  return prisma.brandRequest.findFirst({ where: { applicantBrandId: brandId }, orderBy: { createdAt: "desc" } });
}

/* ------------------------------- Approval -------------------------------- */

export type ApprovalOutcome =
  | { state: "brand"; brand: Brand }
  | { state: "awaiting_domain"; brand: Brand };

/** What a super admin may set when approving — the brand's door, look and settings. Never its status or kind. */
export type ApprovalInput = Omit<Partial<BrandInput>, "status"> & { name: string };

/**
 * Applies the approved setup to the applicant's OWN row. With a domain of their own the account waits for that
 * domain to go live (the 5-minute domain sweep promotes it); with none it becomes a brand now, on its platform
 * subdomain. Throws before anything is written when the setup is invalid (a taken subdomain, a bad colour), so the
 * caller can hand the claim back.
 */
export async function approveAdminRequest(
  request: BrandRequest,
  input: ApprovalInput,
  actorId: string,
): Promise<ApprovalOutcome> {
  if (!request.applicantBrandId || !request.applicantUserId) {
    throw badRequest("This request isn't tied to a customer account.");
  }
  const row = await prisma.brand.findUnique({ where: { id: request.applicantBrandId } });
  if (!row || row.kind !== "customer" || row.ownerUserId !== request.applicantUserId) {
    throw badRequest("The applicant's account has changed since they asked — decline this request.");
  }
  if (row.status !== "active") throw badRequest("The applicant's account is suspended. Restore it first.");

  const { status: _ignored, ...setup } = input as ApprovalInput & { status?: unknown };
  const updated = await updateBrand(row.id, {
    ...setup,
    slug: setup.slug || request.slug || setup.name,
    customDomain: setup.customDomain === undefined ? request.customDomain || null : setup.customDomain,
  });

  if (updated.customDomain && updated.domainStatus !== "verified") {
    const { attachDomainToEdge, domainInstructions } = await import("./brandDomains.js");
    // Registered now so the certificate is waiting when the applicant publishes DNS.
    await attachDomainToEdge(updated.customDomain).catch(() => undefined);
    await prisma.brandRequest.update({
      where: { id: request.id },
      data: { status: "awaiting_domain", brandId: row.id, reviewedById: actorId, reviewedAt: new Date() },
    });
    const owner = await ownerContact(updated);
    if (owner) {
      const records = domainInstructions(updated)
        .map((r) => `${r.type}  ${r.fqdn}  →  ${r.value}`)
        .join("\n");
      void sendTemplate("brand_request_domain_pending", owner.email, {
        user_name: owner.fullName,
        brand_name: updated.name,
        brand_domain: updated.customDomain,
        dns_records: records,
      }).catch(() => undefined);
      void notify(owner.id, {
        type: "system",
        title: `${updated.name} is approved`,
        message: `Connect ${updated.customDomain} to finish — your account becomes the Brand Admin once it's live.`,
        link: "/dashboard/brand-admin",
      });
    }
    return { state: "awaiting_domain", brand: updated };
  }

  const brand = await promoteToBrand(row.id, { actorId, requestId: request.id });
  return { state: "brand", brand };
}

/** Name + email of a row's owner, from Main's directory (no tenant opened). */
async function ownerContact(brand: Pick<Brand, "id" | "ownerUserId">) {
  if (!brand.ownerUserId) return null;
  const row = await prisma.customerDirectory.findUnique({
    where: { brandId_userId: { brandId: brand.id, userId: brand.ownerUserId } },
    select: { email: true, fullName: true },
  });
  return row ? { id: brand.ownerUserId, email: row.email, fullName: row.fullName } : null;
}

/* ------------------------------- Promotion -------------------------------- */

/** Turns a customer-state row into a brand: its door opens and its owner becomes the Brand Admin. Idempotent —
 *  a second call (two domain checks racing) finds a brand already and does nothing. */
export async function promoteToBrand(
  brandId: string,
  opts: { actorId?: string | null; requestId?: string | null } = {},
): Promise<Brand> {
  const { count } = await prisma.brand.updateMany({
    where: { id: brandId, kind: "customer" },
    data: { kind: "brand", brandSince: new Date(), statusWarnedFor: "" },
  });
  const brand = (await refreshBrand(brandId))!;
  if (!count) return brand;

  // The owner's role lives in their own database; the directory mirror carries it to Main.
  if (brand.ownerUserId) {
    const db = await tenantFor(brandId);
    await db.user.update({ where: { id: brand.ownerUserId }, data: { role: "ADMIN" } });
    // Any session they still have open on the main domain re-reads who they are, and is sent to the brand's address.
    publishToUser(brand.ownerUserId, { type: "account-moved" });
  }
  const open = await prisma.brandRequest.findFirst({
    where: {
      applicantBrandId: brandId,
      status: { in: OPEN_ADMIN_REQUEST_STATUSES },
      ...(opts.requestId ? { id: opts.requestId } : {}),
    },
    orderBy: { createdAt: "desc" },
  });
  if (open) {
    await prisma.brandRequest.update({
      where: { id: open.id },
      data: {
        status: "approved",
        brandId,
        reviewedAt: open.reviewedAt ?? new Date(),
        ...(opts.actorId ? { reviewedById: opts.actorId } : {}),
      },
    });
  }

  const owner = await ownerContact(brand);
  const url = brandOrigin(brand) ?? appBaseUrl;
  if (owner) {
    void sendTemplate("brand_request_approved", owner.email, {
      user_name: owner.fullName,
      user_email: owner.email,
      brand_name: brand.name,
      brand_url: `${url}/login`,
    }).catch(() => undefined);
    void notify(owner.id, {
      type: "system",
      title: `${brand.name} is live`,
      message: `You're now the Brand Admin. Sign in at ${url} from now on.`,
      link: "/dashboard/admin/overview",
    });
  }
  void audit({
    actorId: opts.actorId ?? undefined,
    actorBrandId: null,
    actorEmail: opts.actorId ? "" : "system",
    action: "brand.promote",
    targetType: "brand",
    targetId: brandId,
    metadata: { slug: brand.slug, domain: brand.customDomain, requestId: open?.id ?? null },
  });
  return brand;
}

/** Called once a domain is verified: a customer-state row whose request was waiting on it becomes the brand. */
export async function promoteIfDomainLive(brandId: string): Promise<Brand | null> {
  const row = cachedBrand(brandId);
  if (!row || !isCustomerBrand(row) || row.domainStatus !== "verified") return null;
  const waiting = await prisma.brandRequest.findFirst({
    where: { applicantBrandId: brandId, status: "awaiting_domain" },
    select: { id: true, reviewedById: true },
  });
  if (!waiting) return null;
  return promoteToBrand(brandId, { actorId: waiting.reviewedById, requestId: waiting.id });
}

/* ------------------------------- Downgrade -------------------------------- */

/**
 * Turns a brand back into its owner's main-domain customer account. Its own domain is handed back to the edge and
 * cleared, its subdomain closes (customer rows open no door), the owner becomes a customer again, and every other
 * account in the database is refused from the next request on (middleware/auth.ts `closedByDowngrade`). Nothing in
 * the database is deleted. Idempotent.
 */
export async function downgradeToCustomer(
  brandId: string,
  opts: { reason: string; actorId?: string | null; notifyOwner?: boolean },
): Promise<Brand> {
  const row = await prisma.brand.findUnique({ where: { id: brandId } });
  if (!row) throw badRequest("Brand not found");
  if (row.kind === "customer") return row;
  if (!row.ownerUserId) throw badRequest("This brand has no owner on record, so it can't become a customer account.");

  const owner = await ownerContact(row);
  const { count } = await prisma.brand.updateMany({
    where: { id: brandId, kind: "brand" },
    data: {
      kind: "customer",
      downgradedAt: new Date(),
      statusWarnedFor: "",
      // A deactivated brand loses its deletion countdown: the customer account it becomes is kept, database and all.
      ...(row.status === "deactivated" ? { status: "active" as const, deactivatedAt: null } : {}),
      // The subdomain goes back to the pool of names; the row keeps a private label of its own.
      slug: customerSlugFor(owner?.email || brandId),
      customDomain: null,
      domainStatus: "none",
      domainToken: "",
      domainVerifiedAt: null,
      domainCheckedAt: null,
      domainError: "",
    },
  });
  const brand = (await refreshBrand(brandId))!;
  if (!count) return brand;

  if (row.customDomain) {
    const { detachDomainFromEdge } = await import("./brandDomains.js");
    await detachDomainFromEdge(row.customDomain).catch((e: unknown) =>
      console.error(`[brand lifecycle] couldn't hand ${row.customDomain} back to the edge:`, e),
    );
  }
  const db = await tenantFor(brandId);
  await db.user.update({ where: { id: row.ownerUserId }, data: { role: "USER" } });

  if (owner && opts.notifyOwner !== false) {
    void sendTemplate("brand_admin_downgraded", owner.email, {
      user_name: owner.fullName,
      brand_name: row.name,
      login_url: `${appBaseUrl}/login`,
    }).catch(() => undefined);
    void notify(owner.id, {
      type: "system",
      title: `${row.name} is now a customer account`,
      message: `Sign in at ${appBaseUrl} from now on.`,
      link: "/dashboard",
    });
  }
  void audit({
    actorId: opts.actorId ?? undefined,
    actorBrandId: null,
    actorEmail: opts.actorId ? "" : "system",
    action: "brand.downgrade",
    targetType: "brand",
    targetId: brandId,
    metadata: { slug: row.slug, domain: row.customDomain, reason: opts.reason },
  });
  return brand;
}

/** Undoes an approval that never went live (declined while waiting on the applicant's domain): the row keeps its
 *  customer state and gets its private label back, and the domain is handed back to the edge. */
export async function cancelPendingSetup(brandId: string): Promise<void> {
  const row = await prisma.brand.findUnique({ where: { id: brandId } });
  if (!row || row.kind !== "customer") return;
  const owner = await ownerContact(row);
  await prisma.brand.update({
    where: { id: brandId },
    data: {
      slug: customerSlugFor(owner?.email || brandId),
      customDomain: null,
      domainStatus: "none",
      domainToken: "",
      domainVerifiedAt: null,
      domainCheckedAt: null,
      domainError: "",
    },
  });
  await refreshBrand(brandId);
  if (row.customDomain) {
    const { detachDomainFromEdge } = await import("./brandDomains.js");
    await detachDomainFromEdge(row.customDomain).catch(() => undefined);
  }
}
