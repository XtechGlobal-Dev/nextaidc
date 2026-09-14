import type { SubscriptionPlan } from "@prisma/client";
import { prisma } from "../prisma.js";
import { tenantFor } from "./tenantDb.js";
import { badRequest, notFound } from "../lib/http.js";
import {
  archiveStripePrice,
  createStripePrice,
  getSubscription,
  isStripeConfigured,
  swapSubscriptionPriceNow,
  type StripeInterval,
} from "./stripe.js";
import { brandPlanIds } from "./brandSetup.js";
import { audit } from "./audit.js";
import { notify } from "./notifications.js";

/** Subscription states that are actually being billed (or about to be). */
const LIVE_STATUSES = ["trialing", "active", "past_due"];

// Brand pricing: customers pay base + the brand's addon, to the platform. A non-zero addon means a
// brand-owned Stripe Price; every subscribe/change path must ask stripePriceIdFor() so base and brand Prices never mix.

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

/** Live subscribers per plan, from the brand's own database. A brand whose
 *  database is not ready yet simply has nobody to count. */
async function subscriberCountsFor(
  brandId: string,
): Promise<{ subscriptionPlanId: string | null; _count: { _all: number } }[]> {
  try {
    const db = await tenantFor(brandId);
    const rows = await db.profile.groupBy({
      by: ["subscriptionPlanId"],
      where: { subscriptionStatus: { in: LIVE_STATUSES } },
      _count: { _all: true },
    });
    return rows.map((r) => ({ subscriptionPlanId: r.subscriptionPlanId, _count: { _all: r._count._all } }));
  } catch {
    return [];
  }
}

export async function listBrandPricing(brandId: string): Promise<BrandPricingRow[]> {
  const [plans, addons, counts] = await Promise.all([
    plansForBrand(brandId),
    prisma.brandPlanAddon.findMany({ where: { brandId } }),
    subscriberCountsFor(brandId),
  ]);
  const byPlan = new Map(addons.map((a) => [a.planId, a]));
  const subscribersByPlan = new Map(
    counts.map((c) => [c.subscriptionPlanId ?? "", c._count._all]),
  );
  return plans.map((p) => {
    const a = byPlan.get(p.id);
    const addonCents = a?.addonCents ?? 0;
    return {
      planId: p.id,
      planName: p.displayName,
      interval: p.interval,
      intervalCount: p.intervalCount,
      currency: p.currency,
      basePriceCents: p.priceCents,
      addonCents,
      brandPriceCents: p.priceCents + addonCents,
      stripeLinked: Boolean(a?.stripePriceId),
      planLinked: Boolean(p.stripeProductId),
      active: p.active,
      subscribers: subscribersByPlan.get(p.id) ?? 0,
    };
  });
}

/** Addon for one (brand, plan), or 0. Cheap: one indexed read. */
export async function brandAddonCents(
  brandId: string | null | undefined,
  planId: string,
): Promise<number> {
  if (!brandId) return 0;
  const a = await prisma.brandPlanAddon.findUnique({
    where: { brandId_planId: { brandId, planId } },
    select: { addonCents: true },
  });
  return a?.addonCents ?? 0;
}

/** Addons for many plans at once — for the public plan list. planId → cents. */
export async function brandAddonsFor(
  brandId: string | null | undefined,
  planIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!brandId || !planIds.length) return out;
  const rows = await prisma.brandPlanAddon.findMany({
    where: { brandId, planId: { in: planIds } },
    select: { planId: true, addonCents: true },
  });
  for (const r of rows) if (r.addonCents > 0) out.set(r.planId, r.addonCents);
  return out;
}

/** The brand's Price when it has an addon and the Price exists, else the platform's. An addon saved before the plan was Stripe-linked sells at base until re-saved — never a checkout failure. */
export async function stripePriceIdFor(
  plan: Pick<SubscriptionPlan, "id" | "stripePriceId">,
  brandId: string | null | undefined,
): Promise<string | null> {
  if (brandId) {
    const a = await prisma.brandPlanAddon.findUnique({
      where: { brandId_planId: { brandId, planId: plan.id } },
      select: { addonCents: true, stripePriceId: true },
    });
    if (a && a.addonCents > 0 && a.stripePriceId) return a.stripePriceId;
  }
  return plan.stripePriceId ?? null;
}

/** Sets (or clears with 0) a brand's addon and keeps Stripe in step. Existing subscribers stay on their Price — never retroactive; applyBrandPriceToSubscribers is the migration tool. */
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
    throw badRequest("Addon must be a whole amount in cents, 0 or more.");
  }

  const brand = await prisma.brand.findUnique({ where: { id: brandId } });
  if (!brand) throw notFound("Brand not found");
  if (opts.asBrand) {
    if (!brand.addonEditable) {
      throw badRequest("Pricing for this brand is managed by the platform.");
    }
    if (typeof brand.maxAddonCents === "number" && addonCents > brand.maxAddonCents) {
      throw badRequest(`The addon may be at most ${brand.maxAddonCents} cents per cycle.`);
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
    if (existing && existing.addonCents === addonCents && previousPriceId) {
      stripePriceId = previousPriceId; // unchanged — keep the live Price
    } else {
      stripePriceId = await createStripePrice(
        plan.stripeProductId,
        plan.priceCents + addonCents,
        plan.currency,
        plan.interval as StripeInterval,
        plan.intervalCount,
      );
    }
  }

  const row = await prisma.brandPlanAddon.upsert({
    where: { brandId_planId: { brandId, planId } },
    create: { brandId, planId, addonCents, stripePriceId },
    update: { addonCents, stripePriceId },
  });

  // Retire the Price nobody new should land on. Best-effort: subscriptions
  // already on it keep billing (archiving only stops new use).
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

  return {
    planId: plan.id,
    planName: plan.displayName,
    interval: plan.interval,
    intervalCount: plan.intervalCount,
    currency: plan.currency,
    basePriceCents: plan.priceCents,
    addonCents,
    brandPriceCents: plan.priceCents + addonCents,
    stripeLinked: Boolean(row.stripePriceId),
    planLinked: Boolean(plan.stripeProductId),
    active: plan.active,
    subscribers: (await subscriberCountsFor(brandId)).find((c) => c.subscriptionPlanId === planId)?._count._all ?? 0,
  };
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

/** The brand's addon on a plan, but only if `priceId` IS the brand's Price for
 *  it — i.e. the amount actually being billed on top of the base. 0 otherwise. */
export async function brandAddonOnPrice(
  planId: string,
  brandId: string | null | undefined,
  priceId: string | null | undefined,
): Promise<number> {
  if (!brandId || !priceId) return 0;
  const addon = await prisma.brandPlanAddon.findUnique({
    where: { brandId_planId: { brandId, planId } },
    select: { addonCents: true, stripePriceId: true },
  });
  return addon && addon.addonCents > 0 && addon.stripePriceId === priceId ? addon.addonCents : 0;
}

/** What the customer is actually billed: base + addon only if their sub really is on the brand's Price (pre-addon subscribers stay on base). Falls back to base when Stripe can't be asked. */
export async function customerPlanPriceCents(opts: {
  plan: { id: string; priceCents: number };
  brandId: string | null | undefined;
  stripeSubscriptionId: string | null | undefined;
}): Promise<number> {
  const base = opts.plan.priceCents;
  if (!opts.brandId || !opts.stripeSubscriptionId) return base;
  const addon = await prisma.brandPlanAddon.findUnique({
    where: { brandId_planId: { brandId: opts.brandId, planId: opts.plan.id } },
    select: { addonCents: true, stripePriceId: true },
  });
  if (!addon || addon.addonCents <= 0 || !addon.stripePriceId) return base;
  try {
    const live = await getSubscription(opts.stripeSubscriptionId);
    return live.priceId === addon.stripePriceId ? base + addon.addonCents : base;
  } catch {
    return base;
  }
}

/** After a base-price change, rebuilds every brand Price on the plan and notifies brand admins. Best-effort per brand so one Stripe failure doesn't stop the rest. */
export async function refreshBrandPricesForPlan(
  planId: string,
): Promise<{ refreshed: number; failed: number }> {
  const plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId } });
  if (!plan) return { refreshed: 0, failed: 0 };
  const addons = (await prisma.brandPlanAddon.findMany({ where: { planId } })).filter(
    (a) => a.addonCents > 0,
  );
  let refreshed = 0;
  let failed = 0;
  for (const addon of addons) {
    try {
      let stripePriceId = "";
      if (plan.stripeProductId && isStripeConfigured()) {
        stripePriceId = await createStripePrice(
          plan.stripeProductId,
          plan.priceCents + addon.addonCents,
          plan.currency,
          plan.interval as StripeInterval,
          plan.intervalCount,
        );
      }
      await prisma.brandPlanAddon.update({ where: { id: addon.id }, data: { stripePriceId } });
      if (addon.stripePriceId && addon.stripePriceId !== stripePriceId) {
        await archiveStripePrice(addon.stripePriceId).catch(() => undefined);
      }
      refreshed += 1;

      const admins = await tenantFor(addon.brandId)
        .then((db) => db.user.findMany({ where: { role: "ADMIN" }, select: { id: true } }))
        .catch(() => []);
      const total = ((plan.priceCents + addon.addonCents) / 100).toFixed(2);
      for (const a of admins) {
        void notify(a.id, {
          type: "billing",
          title: `${plan.displayName} base price changed`,
          message: `The platform now charges ${(plan.priceCents / 100).toFixed(2)} ${plan.currency.toUpperCase()} for ${plan.displayName}. With your addon of ${(addon.addonCents / 100).toFixed(2)}, new customers pay ${total} ${plan.currency.toUpperCase()}.`,
          link: "/dashboard/admin/pricing",
        });
      }
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

export interface ApplyPriceResult {
  /** The Price subscribers were moved to. */
  priceId: string;
  moved: number;
  alreadyOn: number;
  skipped: { email: string; reason: string }[];
}

/** Moves existing subscribers onto the brand's current Price. No proration, no charge now — bills from next cycle. Subs with a scheduled change are reported, not forced. */
export async function applyBrandPriceToSubscribers(opts: {
  brandId: string;
  planId: string;
  actor: { id: string; email: string; ip?: string };
}): Promise<ApplyPriceResult> {
  const plan = await prisma.subscriptionPlan.findUnique({ where: { id: opts.planId } });
  if (!plan) throw notFound("Plan not found");
  const target = await stripePriceIdFor(plan, opts.brandId);
  if (!target) throw badRequest("That plan isn't linked to Stripe yet.");

  const profiles = await (await tenantFor(opts.brandId)).profile.findMany({
    where: {
      subscriptionPlanId: opts.planId,
      subscriptionStatus: { in: LIVE_STATUSES },
      stripeSubscriptionId: { not: null },
    },
    select: { userId: true, stripeSubscriptionId: true, user: { select: { email: true } } },
  });

  const result: ApplyPriceResult = { priceId: target, moved: 0, alreadyOn: 0, skipped: [] };
  for (const p of profiles) {
    const email = p.user?.email ?? p.userId;
    try {
      const live = await getSubscription(p.stripeSubscriptionId!);
      if (live.priceId === target) {
        result.alreadyOn += 1;
        continue;
      }
      if (live.scheduleId) {
        result.skipped.push({ email, reason: "has a scheduled plan change" });
        continue;
      }
      if (live.status !== "trialing" && live.status !== "active" && live.status !== "past_due") {
        result.skipped.push({ email, reason: `subscription is ${live.status}` });
        continue;
      }
      await swapSubscriptionPriceNow(p.stripeSubscriptionId!, target);
      result.moved += 1;
    } catch (e) {
      result.skipped.push({ email, reason: e instanceof Error ? e.message : "Stripe error" });
    }
  }

  void audit({
    actorId: opts.actor.id,
    actorEmail: opts.actor.email,
    action: "brand.pricing.apply",
    targetType: "brand",
    targetId: opts.brandId,
    metadata: {
      planId: opts.planId,
      priceId: target,
      moved: result.moved,
      alreadyOn: result.alreadyOn,
      skipped: result.skipped.length,
    },
    ip: opts.actor.ip,
  });
  return result;
}
