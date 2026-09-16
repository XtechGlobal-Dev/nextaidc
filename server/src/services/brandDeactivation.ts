import type { Brand } from "@prisma/client";
import { prisma } from "../prisma.js";
import { badRequest, notFound } from "../lib/http.js";
import { audit } from "./audit.js";
import { BRAND_DEACTIVATION_DAYS, deleteBrand, loadBrands } from "./brands.js";
import { detachDomainFromEdge } from "./brandDomains.js";

// Two ways off the platform. Deactivate: the brand goes offline now and the daily sweep deletes it
// (row and database) 30 days on unless it is reactivated first. Delete: gone now, database included.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Switches a brand off and starts its 30-day countdown. */
export async function deactivateBrand(id: string): Promise<Brand> {
  const existing = await prisma.brand.findUnique({ where: { id } });
  if (!existing) throw notFound("Brand not found");
  if (existing.status === "deactivated") throw badRequest("This brand is already deactivated.");
  // In setup there is nothing to switch off; Retry finishes it, or Delete removes it.
  if (existing.status === "provisioning" || existing.status === "failed") {
    throw badRequest("This brand's database isn't ready yet — finish setup (Retry) or delete the brand.");
  }
  const brand = await prisma.brand.update({
    where: { id },
    data: { status: "deactivated", deactivatedAt: new Date() },
  });
  await loadBrands();
  return brand;
}

/** Cancels the countdown and puts the brand back online. */
export async function reactivateBrand(id: string): Promise<Brand> {
  const existing = await prisma.brand.findUnique({ where: { id } });
  if (!existing) throw notFound("Brand not found");
  if (existing.status !== "deactivated") throw badRequest("This brand isn't deactivated.");
  const brand = await prisma.brand.update({
    where: { id },
    data: { status: "active", deactivatedAt: null },
  });
  await loadBrands();
  return brand;
}

/** Deletes a brand for good: hands its hostname back to the edge, drops its database, removes the row. */
export async function destroyBrand(brand: Pick<Brand, "id" | "customDomain">): Promise<void> {
  // Hand the hostname back before the row goes, or it keeps resolving to this
  // deployment with no tenant behind it — and stays unclaimable by anyone else.
  if (brand.customDomain) await detachDomainFromEdge(brand.customDomain);
  await deleteBrand(brand.id);
}

/** Deletes every brand whose deactivation countdown has run out. Daily. Each
 *  one is independent: a Neon outage on one must not stall the rest. */
export async function runBrandDeactivationSweep(now = new Date()): Promise<{ deleted: string[] }> {
  const cutoff = new Date(now.getTime() - BRAND_DEACTIVATION_DAYS * DAY_MS);
  const due = await prisma.brand.findMany({
    where: { status: "deactivated", deactivatedAt: { lte: cutoff } },
    select: { id: true, slug: true, name: true, customDomain: true, deactivatedAt: true },
  });
  const deleted: string[] = [];
  for (const b of due) {
    try {
      await destroyBrand(b);
      deleted.push(b.slug);
      void audit({
        actorEmail: "system",
        actorBrandId: null,
        action: "brand.delete",
        targetType: "brand",
        targetId: b.id,
        metadata: { slug: b.slug, name: b.name, reason: "deactivation_expired", deactivatedAt: b.deactivatedAt },
      });
      console.log(`[brands] deleted deactivated brand ${b.slug} (deactivated ${b.deactivatedAt?.toISOString()})`);
    } catch (e) {
      console.error(`[brands] could not delete deactivated brand ${b.slug}:`, e);
    }
  }
  return { deleted };
}
