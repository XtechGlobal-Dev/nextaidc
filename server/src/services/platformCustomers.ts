import { createHash, randomBytes } from "node:crypto";
import type { Brand } from "@prisma/client";
import { prisma } from "../prisma.js";
import { HttpError } from "../lib/http.js";
import { cachedBrand, provisionBrand, refreshBrand } from "./brands.js";
import { tenantFor } from "./tenantDb.js";
import { claimSpare } from "./customerPool.js";
import { audit } from "./audit.js";

// Main-domain customers (docs/brand-as-customer-plan.md). Every sign-up on the platform's own door gets
// its own brand row in the CUSTOMER state and its own database: the row opens no door and wears the
// platform's look, and an approved Brand Setup Request later flips the same row into a brand.

/** The row's subdomain label, derived from the email so a retried sign-up finds the row it already made
 *  instead of minting a second database. Never a door (customer rows don't resolve), so it leaks nothing. */
export function customerSlugFor(email: string): string {
  return `c-${createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 12)}`;
}

/** A fresh account id in the shape the database mints (`c` + base-36), chosen before the account exists so the
 *  row can name its owner in the same write that claims it. */
export function newAccountId(): string {
  return `c${BigInt(`0x${randomBytes(16).toString("hex")}`).toString(36).padStart(25, "0").slice(0, 24)}`;
}

/** Both sign-up questions from ONE directory read: the main-domain account this email already has (see
 *  findPlatformCustomer), and whether it owns any other account (see emailOwnsAccount). */
export async function platformAccountFor(
  email: string,
): Promise<{ mine: { brandId: string; userId: string; ownerSet: boolean } | null; ownsAccount: boolean }> {
  const rows = await prisma.customerDirectory.findMany({
    where: { email },
    select: { brandId: true, userId: true, brand: { select: { kind: true, ownerUserId: true } } },
  });
  const customer = rows.filter((r) => r.brand.kind === "customer");
  const mine =
    customer.find((r) => r.brand.ownerUserId === r.userId) ?? customer.find((r) => r.brand.ownerUserId === null);
  return {
    mine: mine ? { brandId: mine.brandId, userId: mine.userId, ownerSet: mine.brand.ownerUserId !== null } : null,
    ownsAccount: rows.some(
      (r) => r.brand.ownerUserId === r.userId || (r.brand.kind === "customer" && r.brand.ownerUserId === null),
    ),
  };
}

/** The main-domain account for this email: the OWNER of a customer-state row. A downgraded brand's own
 *  customers are in that database too, but they are not main-domain customers. An owner not yet stamped
 *  (sign-up interrupted between the account and the stamp) still counts, so recovery can finish it. */
export async function findPlatformCustomer(
  email: string,
): Promise<{ brandId: string; userId: string; ownerSet: boolean } | null> {
  const rows = await prisma.customerDirectory.findMany({
    where: { email, brand: { kind: "customer" } },
    select: { brandId: true, userId: true, brand: { select: { ownerUserId: true } } },
  });
  const mine = rows.find((r) => r.brand.ownerUserId === r.userId) ?? rows.find((r) => r.brand.ownerUserId === null);
  return mine ? { brandId: mine.brandId, userId: mine.userId, ownerSet: mine.brand.ownerUserId !== null } : null;
}

/** True when this email already owns an account on the platform: a main-domain customer, or a brand's
 *  owner (who signs in on their brand's door). One person, one owned account. */
export async function emailOwnsAccount(email: string): Promise<boolean> {
  const rows = await prisma.customerDirectory.findMany({
    where: { email },
    select: { userId: true, brand: { select: { kind: true, ownerUserId: true } } },
  });
  return rows.some(
    (r) => r.brand.ownerUserId === r.userId || (r.brand.kind === "customer" && r.brand.ownerUserId === null),
  );
}

/** A row still "provisioning" after this long was abandoned by a process that restarted mid-setup. */
const STUCK_SETUP_MS = 10 * 60 * 1000;

/** The customer-state row + database for a new main-domain sign-up: created on first call, provisioning
 *  retried on a later one. Throws 503 `brand_not_ready` while (or when) the database can't be used yet. */
export async function customerBrandFor(email: string, name: string, ownerUserId?: string): Promise<Brand> {
  const slug = customerSlugFor(email);
  let brand = await prisma.brand.findUnique({ where: { slug } });
  if (brand && brand.kind !== "customer") {
    // The label was claimed some other way; a sign-up never takes over a brand.
    throw new HttpError(409, "Email already registered");
  }
  if (!brand) {
    // A ready spare first: a single row update instead of waiting for a fresh database.
    brand = await claimSpare(slug, name.trim() || email.trim(), ownerUserId);
  }
  if (!brand) {
    brand = await prisma.brand
      .create({
        data: {
          name: name.trim() || email.trim(),
          slug,
          kind: "customer",
          status: "provisioning",
          ...(ownerUserId ? { ownerUserId } : {}),
        },
      })
      .catch(async (e: unknown) => {
        // Two verifies racing: the other one made it — use that row.
        const again = await prisma.brand.findUnique({ where: { slug } });
        if (again) return again;
        throw e;
      });
    await refreshBrand(brand.id);
    brand = await provisionBrand(brand.id);
  } else if (
    brand.status === "failed" ||
    // Set up by a process that restarted mid-way (a deploy): left alone it would say "try again" for ever.
    (brand.status === "provisioning" && brand.updatedAt.getTime() < Date.now() - STUCK_SETUP_MS)
  ) {
    brand = await provisionBrand(brand.id);
  }
  if (brand.status !== "active") {
    throw new HttpError(503, "We're still setting up your account. Try again in a moment.", "brand_not_ready");
  }
  return brand;
}

/** Records the account that owns a customer-state row (set once, at sign-up). */
export async function setBrandOwner(brandId: string, userId: string): Promise<void> {
  await prisma.brand.update({ where: { id: brandId }, data: { ownerUserId: userId } });
  await refreshBrand(brandId);
}

/** Stamps the first time a row's owner started a plan or trial; later calls are no-ops. Keeps the
 *  row out of the abandoned sign-up sweep for good. */
export async function markBrandActivated(brandId: string | null | undefined, at = new Date()): Promise<void> {
  if (!brandId) return;
  const cached = cachedBrand(brandId);
  if (cached?.activatedAt) return;
  const { count } = await prisma.brand.updateMany({
    where: { id: brandId, activatedAt: null },
    data: { activatedAt: at },
  });
  if (count) await refreshBrand(brandId);
}

/** Days a main-domain sign-up may sit without ever starting a plan or trial before it is deleted. */
export const ABANDONED_SIGNUP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Has this account ever started a plan or a trial? Read from its own database, so no billing path needs to
 *  remember to stamp it. */
async function everActivated(brandId: string, ownerUserId: string | null): Promise<boolean> {
  const db = await tenantFor(brandId);
  const where = ownerUserId ? { userId: ownerUserId } : {};
  const [profile, events] = await Promise.all([
    db.profile.findFirst({ where, select: { subscriptionStatus: true, trialStartedAt: true } }),
    db.planEvent.count({ where }),
  ]);
  return events > 0 || !!profile?.trialStartedAt || (!!profile && profile.subscriptionStatus !== "none");
}

/** Deletes main-domain sign-ups that never started a plan or trial within 30 days (row and database). One that
 *  did is stamped `activatedAt` instead and never looked at again. Daily; each row is independent. */
export async function runAbandonedSignupSweep(now = new Date()): Promise<{ deleted: string[]; kept: string[] }> {
  const { destroyBrand } = await import("./brandDeactivation.js");
  const cutoff = new Date(now.getTime() - ABANDONED_SIGNUP_DAYS * DAY_MS);
  const due = await prisma.brand.findMany({
    where: { kind: "customer", poolSpare: false, activatedAt: null, brandSince: null, createdAt: { lte: cutoff } },
    select: { id: true, slug: true, name: true, customDomain: true, status: true, ownerUserId: true, createdAt: true },
  });
  const deleted: string[] = [];
  const kept: string[] = [];
  for (const b of due) {
    try {
      // A database that never came up holds nothing worth keeping.
      if (b.status === "active" && (await everActivated(b.id, b.ownerUserId))) {
        await markBrandActivated(b.id, now);
        kept.push(b.slug);
        continue;
      }
      if (b.status !== "active" && b.status !== "failed") continue;
      await destroyBrand(b);
      deleted.push(b.slug);
      void audit({
        actorEmail: "system",
        actorBrandId: null,
        action: "brand.delete",
        targetType: "brand",
        targetId: b.id,
        metadata: { slug: b.slug, name: b.name, reason: "abandoned_signup", createdAt: b.createdAt },
      });
    } catch (e) {
      console.error(`[platform customers] abandoned sign-up sweep failed for ${b.slug}:`, e);
    }
  }
  return { deleted, kept };
}
