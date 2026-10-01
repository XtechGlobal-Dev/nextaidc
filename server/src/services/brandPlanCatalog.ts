import type { BrandAddonPrice, BrandPlan, Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { badRequest, notFound } from "../lib/http.js";
import { loadBrands } from "./brands.js";
import {
  BRAND_MODULES,
  brandFeaturePrices,
  brandModuleLabel,
  brandOwesPlatform,
  brandPurchasedFeatures,
  isAddonEligible,
  isBrandModuleId,
  type BrandModuleId,
} from "./brandSetup.js";
import { syncBrandSubscription } from "./brandBilling.js";
import { ensureBillingRow } from "./brandUsage.js";

// Brand plans: what a BRAND pays the PLATFORM, as a catalog. A plan is a monthly price plus the modules it
// includes; every module it doesn't include is sold as an add-on at the add-on list's price (or not offered
// when the list doesn't carry it). A brand on a plan has its fee, feature access, add-on prices and caps
// WRITTEN from the plan — the rest of billing (Stripe, gating, holds) reads those columns and needs no
// idea that plans exist. Entirely separate from SubscriptionPlan, which is what a brand sells ITS customers.

export interface BrandPlanView {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  /** Module ids included in the price. */
  features: BrandModuleId[];
  monthlyMinuteLimit: number | null;
  monthlyAiLimit: number | null;
  active: boolean;
  sortOrder: number;
  /** "Popular" on the request form. */
  recommended: boolean;
  /** Pre-selected on the request form and in the wizard (at most one). */
  isDefault: boolean;
  /** How many brands are on it (admin views only). */
  brandCount?: number;
}

export interface BrandAddonView {
  moduleId: BrandModuleId;
  label: string;
  description: string;
  /** Monthly, in the brand's plan currency; null = not priced yet. */
  priceCents: number | null;
  /** Offered to brands whose plan doesn't include it. */
  active: boolean;
}

export function planFeatures(plan: Pick<BrandPlan, "features">): BrandModuleId[] {
  return Array.isArray(plan.features) ? plan.features.filter(isBrandModuleId) : [];
}

export function serializeBrandPlan(plan: BrandPlan, brandCount?: number): BrandPlanView {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    priceCents: plan.priceCents,
    currency: plan.currency,
    features: planFeatures(plan),
    monthlyMinuteLimit: plan.monthlyMinuteLimit,
    monthlyAiLimit: plan.monthlyAiLimit,
    active: plan.active,
    sortOrder: plan.sortOrder,
    recommended: plan.recommended,
    isDefault: plan.isDefault,
    ...(brandCount !== undefined ? { brandCount } : {}),
  };
}

export async function listBrandPlans(opts: { activeOnly?: boolean; withCounts?: boolean } = {}): Promise<BrandPlanView[]> {
  const plans = await prisma.brandPlan.findMany({
    where: opts.activeOnly ? { active: true } : {},
    orderBy: [{ sortOrder: "asc" }, { priceCents: "asc" }, { createdAt: "asc" }],
    ...(opts.withCounts ? { include: { _count: { select: { brands: true } } } } : {}),
  });
  return plans.map((p) =>
    serializeBrandPlan(p, opts.withCounts ? (p as BrandPlan & { _count: { brands: number } })._count.brands : undefined),
  );
}

/* --------------------------------- Add-ons -------------------------------- */

async function addonRows(): Promise<Map<string, BrandAddonPrice>> {
  const rows = await prisma.brandAddonPrice.findMany();
  return new Map(rows.map((r) => [r.moduleId, r]));
}

/** Every sellable module, with its add-on price and whether it's offered. SMS to Caller and WhatsApp never
 *  appear here — they're default features (bundled whenever switched on), not something sold separately. */
export async function listAddonPrices(opts: { activeOnly?: boolean } = {}): Promise<BrandAddonView[]> {
  const rows = await addonRows();
  return BRAND_MODULES.filter((m) => isAddonEligible(m.id))
    .map((m) => {
      const row = rows.get(m.id);
      return {
        moduleId: m.id,
        label: m.label,
        description: m.description,
        priceCents: row?.priceCents ?? null,
        active: !!row?.active && (row?.priceCents ?? 0) > 0,
      };
    })
    .filter((a) => !opts.activeOnly || a.active);
}

export interface AddonPriceInput {
  moduleId: string;
  priceCents: number;
  active: boolean;
}

/** Saves the add-on list, then re-applies every plan-based brand: a new price shows on their next invoice,
 *  and an add-on taken off the list stops being sold (and charged). */
export async function saveAddonPrices(input: AddonPriceInput[]): Promise<BrandAddonView[]> {
  for (const a of input) {
    if (!isBrandModuleId(a.moduleId)) throw badRequest(`Unknown feature "${a.moduleId}".`);
    if (!isAddonEligible(a.moduleId)) {
      throw badRequest(`${brandModuleLabel(a.moduleId)} is a default feature — it can't be sold as an add-on.`);
    }
    if (!Number.isInteger(a.priceCents) || a.priceCents < 0 || a.priceCents > 10_000_000) {
      throw badRequest(`${brandModuleLabel(a.moduleId)}: the price must be a whole amount.`);
    }
    if (a.active && a.priceCents <= 0) {
      throw badRequest(`${brandModuleLabel(a.moduleId)}: give it a price above zero, or switch it off.`);
    }
  }
  await prisma.$transaction(
    input.map((a) =>
      prisma.brandAddonPrice.upsert({
        where: { moduleId: a.moduleId },
        create: { moduleId: a.moduleId, priceCents: a.priceCents, active: a.active },
        update: { priceCents: a.priceCents, active: a.active },
      }),
    ),
  );
  await reapplyPlans({ brandPlanId: { not: null } });
  return listAddonPrices();
}

/* ---------------------------------- Plans --------------------------------- */

export interface BrandPlanInput {
  name: string;
  description?: string;
  priceCents: number;
  currency: string;
  features: string[];
  monthlyMinuteLimit?: number | null;
  monthlyAiLimit?: number | null;
  active?: boolean;
  sortOrder?: number;
  recommended?: boolean;
  isDefault?: boolean;
}

function planData(input: Partial<BrandPlanInput>): Prisma.BrandPlanUpdateInput {
  const data: Prisma.BrandPlanUpdateInput = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 60) throw badRequest("Give the plan a name (2–60 characters).");
    data.name = name;
  }
  if (input.description !== undefined) data.description = input.description.trim().slice(0, 500);
  if (input.priceCents !== undefined) {
    if (!Number.isInteger(input.priceCents) || input.priceCents < 0 || input.priceCents > 10_000_000) {
      throw badRequest("The monthly price must be a whole amount (0 for a free plan).");
    }
    data.priceCents = input.priceCents;
  }
  if (input.currency !== undefined) {
    const c = input.currency.trim().toLowerCase();
    if (!/^[a-z]{3}$/.test(c)) throw badRequest("Currency must be a three-letter code like usd.");
    data.currency = c;
  }
  if (input.features !== undefined) data.features = [...new Set(input.features.filter(isBrandModuleId))];
  for (const key of ["monthlyMinuteLimit", "monthlyAiLimit"] as const) {
    const v = input[key];
    if (v === undefined) continue;
    if (v !== null && (!Number.isInteger(v) || v < 0 || v > 10_000_000)) {
      throw badRequest("Monthly limits must be whole numbers, or blank for no limit.");
    }
    data[key] = v;
  }
  if (input.active !== undefined) data.active = input.active;
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
  if (input.recommended !== undefined) data.recommended = input.recommended;
  if (input.isDefault !== undefined) data.isDefault = input.isDefault;
  // An archived plan isn't offered, so it can't be the one offered first.
  if (input.active === false) data.isDefault = false;
  return data;
}

/** Only one plan is the default: when `id` becomes it, the others let go. */
async function keepOneDefault(id: string): Promise<void> {
  await prisma.brandPlan.updateMany({ where: { isDefault: true, id: { not: id } }, data: { isDefault: false } });
}

export async function createBrandPlan(input: BrandPlanInput): Promise<BrandPlanView> {
  const data = planData(input) as Prisma.BrandPlanCreateInput;
  if (!data.name || data.priceCents === undefined) throw badRequest("A plan needs a name and a monthly price.");
  const plan = await prisma.brandPlan.create({ data });
  if (plan.isDefault) await keepOneDefault(plan.id);
  return serializeBrandPlan(plan, 0);
}

/** Edits a plan; every brand on it follows (new amounts from its next invoice). The currency can't change
 *  under a live Stripe subscription, so it's refused while any brand on the plan is billed. */
export async function updateBrandPlan(id: string, input: Partial<BrandPlanInput>): Promise<BrandPlanView> {
  const existing = await prisma.brandPlan.findUnique({ where: { id } });
  if (!existing) throw notFound("Brand plan not found");
  const data = planData(input);
  if (data.currency && data.currency !== existing.currency) {
    const billed = await prisma.brand.count({
      where: { brandPlanId: id, billing: { stripeSubscriptionId: { not: null } } },
    });
    if (billed) {
      throw badRequest(`${billed} brand${billed === 1 ? " is" : "s are"} billed in ${existing.currency.toUpperCase()} on this plan — the currency can't change now. Create a new plan instead.`);
    }
  }
  const plan = await prisma.brandPlan.update({ where: { id }, data });
  if (plan.isDefault) await keepOneDefault(plan.id);
  await reapplyPlans({ brandPlanId: id });
  const count = await prisma.brand.count({ where: { brandPlanId: id } });
  return serializeBrandPlan(plan, count);
}

/** Deletes a plan nobody is on. One in use is archived instead — its brands keep it. */
export async function deleteBrandPlan(id: string): Promise<void> {
  const inUse = await prisma.brand.count({ where: { brandPlanId: id } });
  if (inUse) throw badRequest(`${inUse} brand${inUse === 1 ? " is" : "s are"} on this plan — archive it instead.`);
  await prisma.brandPlan.delete({ where: { id } }).catch(() => {
    throw notFound("Brand plan not found");
  });
}

/* ------------------------------ Brands on plans ---------------------------- */

/** The billing columns a plan gives a brand: its price as the fee, its features included, every other module
 *  an add-on at the list price (off when the list doesn't offer it), its caps. */
export function planConfig(
  plan: Pick<BrandPlan, "priceCents" | "currency" | "features" | "monthlyMinuteLimit" | "monthlyAiLimit">,
  addons: Map<string, Pick<BrandAddonPrice, "priceCents" | "active">>,
) {
  const included = new Set(planFeatures(plan));
  const modules: Record<string, boolean> = {};
  const featurePrices: Record<string, number> = {};
  for (const m of BRAND_MODULES) {
    if (included.has(m.id)) {
      modules[m.id] = true;
      continue;
    }
    // A default feature (SMS to Caller, WhatsApp) the plan leaves out is simply off — never sold as an
    // add-on, even if a stale price row exists for it.
    const addon = isAddonEligible(m.id) ? addons.get(m.id) : undefined;
    const offered = !!addon?.active && addon.priceCents > 0;
    modules[m.id] = offered;
    if (offered) featurePrices[m.id] = addon!.priceCents;
  }
  return {
    platformFeeCents: plan.priceCents,
    platformFeeCurrency: plan.currency,
    modules,
    featurePrices,
    monthlyMinuteLimit: plan.monthlyMinuteLimit,
    monthlyAiLimit: plan.monthlyAiLimit,
  };
}

/** Rewrites a brand's billing from its plan, then brings Stripe and the hold in line. No plan = no-op. */
export async function applyBrandPlan(brandId: string): Promise<void> {
  const brand = await prisma.brand.findUnique({ where: { id: brandId }, include: { brandPlan: true } });
  if (!brand?.brandPlan) return;
  const config = planConfig(brand.brandPlan, await addonRows());
  await prisma.brand.update({ where: { id: brandId }, data: config });
  await loadBrands();
  if (config.platformFeeCents > 0) await ensureBillingRow(brandId);
  await syncBrandSubscription(brandId);
}

/** Puts a brand on a plan (null = back to billing by hand, keeping what the plan had set). */
export async function assignBrandPlan(brandId: string, planId: string | null): Promise<void> {
  if (planId) {
    const plan = await prisma.brandPlan.findUnique({ where: { id: planId }, select: { id: true } });
    if (!plan) throw badRequest("That brand plan doesn't exist.");
  }
  await prisma.brand.update({ where: { id: brandId }, data: { brandPlanId: planId } });
  if (planId) await applyBrandPlan(brandId);
  else await loadBrands();
}

/** Re-applies every matching brand's plan. One failure (Stripe unreachable) never stops the rest. */
async function reapplyPlans(where: Prisma.BrandWhereInput): Promise<void> {
  const brands = await prisma.brand.findMany({ where, select: { id: true } });
  for (const b of brands) {
    await applyBrandPlan(b.id).catch((e: unknown) => console.error(`[brand-plans] re-apply failed for ${b.id}:`, e));
  }
}

/* -------------------------------- Overview -------------------------------- */

export interface BrandSubscriptionRow {
  brandId: string;
  name: string;
  slug: string;
  primaryColor: string;
  accentColor: string;
  logoLightUrl: string;
  brandStatus: string;
  plan: { id: string; name: string; active: boolean } | null;
  /** Owes something but isn't on a plan: billed by hand. */
  custom: boolean;
  feeCents: number;
  currency: string;
  addOns: { id: BrandModuleId; label: string; priceCents: number }[];
  monthlyTotalCents: number;
  /** none | awaiting_card | active | past_due | canceled */
  billingStatus: string;
  currentPeriodEnd: string | null;
  lastPaidAt: string | null;
  card: { brand: string; last4: string } | null;
  serviceHold: string;
}

/** Every brand and what it pays the platform — the Brand Subscriptions table. */
export async function brandSubscriptionsOverview(): Promise<BrandSubscriptionRow[]> {
  const brands = await prisma.brand.findMany({
    include: { billing: true, brandPlan: true },
    orderBy: { createdAt: "desc" },
  });
  return brands.map((b) => {
    const prices = brandFeaturePrices(b);
    const addOns = brandPurchasedFeatures(b)
      .filter((id) => prices[id] !== undefined)
      .map((id) => ({ id, label: brandModuleLabel(id), priceCents: prices[id]! }));
    const owes = brandOwesPlatform(b);
    return {
      brandId: b.id,
      name: b.name,
      slug: b.slug,
      primaryColor: b.primaryColor,
      accentColor: b.accentColor,
      logoLightUrl: b.logoLightUrl,
      brandStatus: b.status,
      plan: b.brandPlan ? { id: b.brandPlan.id, name: b.brandPlan.name, active: b.brandPlan.active } : null,
      custom: !b.brandPlanId && owes,
      feeCents: b.platformFeeCents,
      currency: b.platformFeeCurrency,
      addOns,
      monthlyTotalCents: b.platformFeeCents + addOns.reduce((s, a) => s + a.priceCents, 0),
      billingStatus: owes ? (b.billing?.status ?? "awaiting_card") : "none",
      currentPeriodEnd: b.billing?.currentPeriodEnd?.toISOString() ?? null,
      lastPaidAt: b.billing?.lastPaidAt?.toISOString() ?? null,
      card: b.billing?.cardLast4 ? { brand: b.billing.cardBrand, last4: b.billing.cardLast4 } : null,
      serviceHold: b.serviceHold,
    };
  });
}
