import type { SubscriptionPlan } from "@prisma/client";
import { prisma } from "../prisma.js";
import { tenantFor } from "./tenantDb.js";
import { badRequest, notFound } from "../lib/http.js";
import {
  archiveStripePrice,
  createStripePrice,
  getSubscription,
  isStripeConfigured,
  type StripeInterval,
} from "./stripe.js";
import { brandPlanIds } from "./brandSetup.js";
import { livePlanSubscribers } from "./brandPlans.js";
import { cachedBrand } from "./brands.js";
import { audit } from "./audit.js";
import { notifyIn } from "./notifications.js";

// Brand price add-on (owner, 9 Oct 2026): a brand sells a platform plan at base + its own add-on. The customer pays
// the whole amount to the platform through a brand-owned Stripe Price; the add-on share is credited to the brand's
// wallet per paid invoice (services/brandWallet.ts). Every subscribe/change path asks stripePriceIdFor() so base and
// brand Prices never mix.
//
// Existing subscribers KEEP the Price they joined on: changing the add-on (or the platform changing the base) makes a
// new Price for new subscriptions and plan changes only. BrandPlanPrice remembers every Price with its split, so a
// renewal on an older Price still credits the share it was sold with.

export interface BrandPricingRow {
  planId: string;
  planName: string;
  interval: string;
  intervalCount: number;
  currency: string;
  basePriceCents: number;
  addonCents: number;
  brandPriceCents: number;
  /** The brand's own Stripe Price exists for this plan. */
  stripeLinked: boolean;
  /** False when the platform plan itself has no Stripe product yet — an
   *  addon can be saved but its Price can't be created until it does. */
  planLinked: boolean;
  active: boolean;
  /** This brand's customers currently on the plan (trialing, active or past due). */
  subscribers: number;
}

/** Only an approved brand sells at its own price. A main-domain customer's row (kind = customer) — including a brand
 *  that was downgraded — sells at the platform's price; its saved add-ons wait, untouched, for it to be a brand again. */
async function sellsWithAddon(brandId: string | null | undefined): Promise<boolean> {
  if (!brandId) return false;
  const cached = cachedBrand(brandId);
  if (cached) return cached.kind === "brand";
  const row = await prisma.brand.findUnique({ where: { id: brandId }, select: { kind: true } });
  return row?.kind === "brand";
}

/** The plans this brand sells: its chosen catalogue, or every active plan. */
async function plansForBrand(brandId: string): Promise<SubscriptionPlan[]> {
  const brand = await prisma.brand.findUnique({ where: { id: brandId } });
  if (!brand) throw notFound("Brand not found");
  const allowed = brandPlanIds(brand);
  return prisma.subscriptionPlan.findMany({
    where: { active: true, ...(allowed.length ? { id: { in: allowed } } : {}) },
    orderBy: [{ sortOrder: "asc" }, { priceCents: "asc" }, { createdAt: "asc" }],
  });
}

function rowFor(
  plan: SubscriptionPlan,
  addon: { addonCents: number; stripePriceId: string } | null | undefined,
  subscribers: number,
): BrandPricingRow {
  const addonCents = addon?.addonCents ?? 0;
  return {
    planId: plan.id,
    planName: plan.displayName,
    interval: plan.interval,
    intervalCount: plan.intervalCount,
    currency: plan.currency,
    basePriceCents: plan.priceCents,
    addonCents,
    brandPriceCents: plan.priceCents + addonCents,
    stripeLinked: Boolean(addon?.stripePriceId),
    planLinked: Boolean(plan.stripeProductId),
    active: plan.active,
    subscribers,
  };
}

export async function listBrandPricing(brandId: string): Promise<BrandPricingRow[]> {
  const [plans, addons, counts] = await Promise.all([
    plansForBrand(brandId),
    prisma.brandPlanAddon.findMany({ where: { brandId } }),
    livePlanSubscribers(brandId),
  ]);
  const byPlan = new Map(addons.map((a) => [a.planId, a]));
  return plans.map((p) => rowFor(p, byPlan.get(p.id), counts.get(p.id) ?? 0));
}

/** Addons for many plans at once — for the public plan list. planId → cents. */
export async function brandAddonsFor(
  brandId: string | null | undefined,
  planIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!brandId || !planIds.length || !(await sellsWithAddon(brandId))) return out;
  const rows = await prisma.brandPlanAddon.findMany({
    where: { brandId, planId: { in: planIds } },
    select: { planId: true, addonCents: true, stripePriceId: true },
  });
  // Only an add-on with a live Price is what checkout will actually charge.
  for (const r of rows) if (r.addonCents > 0 && r.stripePriceId) out.set(r.planId, r.addonCents);
  return out;
}

/** The Price a NEW subscription (or a plan change) lands on: the brand's when it has an add-on and the Price exists,
 *  else the platform's. An add-on saved before the plan was Stripe-linked sells at base until re-saved — never a
 *  checkout failure. */
export async function stripePriceIdFor(
  plan: Pick<SubscriptionPlan, "id" | "stripePriceId">,
  brandId: string | null | undefined,
): Promise<string | null> {
  if (brandId && (await sellsWithAddon(brandId))) {
    const a = await prisma.brandPlanAddon.findUnique({
      where: { brandId_planId: { brandId, planId: plan.id } },
      select: { addonCents: true, stripePriceId: true },
    });
    if (a && a.addonCents > 0 && a.stripePriceId) return a.stripePriceId;
  }
  return plan.stripePriceId ?? null;
}

/** What a brand Price was sold at — current or retired — or null for the platform's own Prices. */
export async function brandPriceSplit(
  priceId: string | null | undefined,
): Promise<{ brandId: string; planId: string; baseCents: number; addonCents: number; currency: string } | null> {
  if (!priceId) return null;
  return prisma.brandPlanPrice.findUnique({
    where: { stripePriceId: priceId },
    select: { brandId: true, planId: true, baseCents: true, addonCents: true, currency: true },
  });
}

/** Creates a brand Price for base + add-on and remembers its split. */
async function createBrandPrice(
  plan: SubscriptionPlan,
  brandId: string,
  addonCents: number,
): Promise<string> {
  const stripePriceId = await createStripePrice(
    plan.stripeProductId!,
    plan.priceCents + addonCents,
    plan.currency,
    plan.interval as StripeInterval,
    plan.intervalCount,
  );
  await prisma.brandPlanPrice.create({
    data: {
      stripePriceId,
      brandId,
      planId: plan.id,
      baseCents: plan.priceCents,
      addonCents,
      currency: plan.currency.toLowerCase(),
    },
  });
  return stripePriceId;
}

/** Sets (or clears with 0) a brand's add-on and keeps Stripe in step. Never retroactive: existing subscribers stay on
 *  the Price they joined on, and the replaced Price is only archived (Stripe keeps billing subscriptions on it). */
export async function setBrandAddon(opts: {
  brandId: string;
  planId: string;
  addonCents: number;
  actor: { id: string; email: string; ip?: string };
  /** True when the brand's own admin is saving — the brand's editability and
   *  cap apply. The super admin bypasses both. */
  asBrand: boolean;
}): Promise<BrandPricingRow> {
  const { brandId, planId, actor } = opts;
  const addonCents = Number(opts.addonCents);
  if (!Number.isInteger(addonCents) || addonCents < 0 || addonCents > 10_000_000) {
    throw badRequest("Add-on must be a whole amount in cents, 0 or more.");
  }

  const brand = await prisma.brand.findUnique({ where: { id: brandId } });
  if (!brand) throw notFound("Brand not found");
  if (brand.kind !== "brand") throw badRequest("Only an approved brand sets its own prices.");
  if (opts.asBrand) {
    if (!brand.addonEditable) {
      throw badRequest("Pricing for this brand is managed by the platform.");
    }
    if (typeof brand.maxAddonCents === "number" && addonCents > brand.maxAddonCents) {
      throw badRequest(`The add-on may be at most ${(brand.maxAddonCents / 100).toFixed(2)} per cycle.`);
    }
  }

  const plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId } });
  if (!plan || !plan.active) throw badRequest("That plan isn't available.");
  const allowed = brandPlanIds(brand);
  if (allowed.length && !allowed.includes(plan.id)) {
    throw badRequest("This brand doesn't sell that plan.");
  }

  const existing = await prisma.brandPlanAddon.findUnique({
    where: { brandId_planId: { brandId, planId } },
  });
  const previousPriceId = existing?.stripePriceId ?? "";

  // A brand Price only when there is something to add and somewhere to add it.
  let stripePriceId = "";
  if (addonCents > 0 && plan.stripeProductId && isStripeConfigured()) {
    stripePriceId =
      existing && existing.addonCents === addonCents && previousPriceId
        ? previousPriceId // unchanged — keep the live Price
        : await createBrandPrice(plan, brandId, addonCents);
  }

  const row = await prisma.brandPlanAddon.upsert({
    where: { brandId_planId: { brandId, planId } },
    create: { brandId, planId, addonCents, stripePriceId },
    update: { addonCents, stripePriceId },
  });

  // Retire the Price nobody NEW should land on. Subscriptions already on it keep billing at it.
  if (previousPriceId && previousPriceId !== stripePriceId) {
    await archiveStripePrice(previousPriceId).catch(() => undefined);
  }

  void audit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: "brand.pricing.addon",
    targetType: "brand",
    targetId: brandId,
    metadata: {
      planId,
      addonCents,
      previousAddonCents: existing?.addonCents ?? 0,
      stripePriceId: row.stripePriceId,
      asBrand: opts.asBrand,
    },
    ip: actor.ip,
  });

  const counts = await livePlanSubscribers(brandId);
  return rowFor(plan, row, counts.get(planId) ?? 0);
}

/* ------------------------- Living with price changes ---------------------- */

/** The Price a subscription is on right now, or null when Stripe can't say. */
export async function livePriceId(
  stripeSubscriptionId: string | null | undefined,
): Promise<string | null> {
  if (!stripeSubscriptionId) return null;
  try {
    return (await getSubscription(stripeSubscriptionId)).priceId;
  } catch {
    return null;
  }
}

/** What a price really costs per cycle: a brand Price's base + add-on as sold, else the plan's own price. */
export async function billedPriceCents(
  plan: { priceCents: number },
  priceId: string | null | undefined,
): Promise<number> {
  const split = await brandPriceSplit(priceId);
  return split ? split.baseCents + split.addonCents : plan.priceCents;
}

/** What the customer is actually billed per cycle, from the Price their subscription is really on. Falls back to the
 *  plan's base when Stripe can't be asked. */
export async function customerPlanPriceCents(opts: {
  plan: { priceCents: number };
  stripeSubscriptionId: string | null | undefined;
}): Promise<number> {
  if (!opts.stripeSubscriptionId) return opts.plan.priceCents;
  return billedPriceCents(opts.plan, await livePriceId(opts.stripeSubscriptionId));
}

/** After a base-price change, gives every brand add-on on the plan a new Price (base + add-on) for NEW subscribers and
 *  tells the brand's admins. Existing subscribers stay on their Price. Best-effort per brand. */
export async function refreshBrandPricesForPlan(
  planId: string,
): Promise<{ refreshed: number; failed: number }> {
  const plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId } });
  if (!plan) return { refreshed: 0, failed: 0 };
  const addons = await prisma.brandPlanAddon.findMany({ where: { planId, addonCents: { gt: 0 } } });
  let refreshed = 0;
  let failed = 0;
  for (const addon of addons) {
    try {
      const stripePriceId =
        plan.stripeProductId && isStripeConfigured()
          ? await createBrandPrice(plan, addon.brandId, addon.addonCents)
          : "";
      await prisma.brandPlanAddon.update({ where: { id: addon.id }, data: { stripePriceId } });
      if (addon.stripePriceId && addon.stripePriceId !== stripePriceId) {
        await archiveStripePrice(addon.stripePriceId).catch(() => undefined);
      }
      refreshed += 1;

      const db = await tenantFor(addon.brandId);
      const admins = await db.user.findMany({ where: { role: "ADMIN" }, select: { id: true } });
      const cur = plan.currency.toUpperCase();
      const total = ((plan.priceCents + addon.addonCents) / 100).toFixed(2);
      void notifyIn(
        db,
        admins.map((a) => a.id),
        {
          type: "billing",
          title: `${plan.displayName} base price changed`,
          message: `The platform now charges ${(plan.priceCents / 100).toFixed(2)} ${cur} for ${plan.displayName}. With your add-on of ${(addon.addonCents / 100).toFixed(2)}, new customers pay ${total} ${cur}. Existing customers keep their price.`,
          link: "/dashboard/admin/pricing",
        },
      );
    } catch (e) {
      failed += 1;
      console.warn(
        `Brand price refresh failed for brand ${addon.brandId} / plan ${planId}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return { refreshed, failed };
}
