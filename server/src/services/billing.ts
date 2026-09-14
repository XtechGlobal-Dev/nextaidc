import { prisma } from "../prisma.js";
import { cachedBrand } from "./brands.js";
import { currentBrandId } from "../lib/brandContext.js";
import { createBillingDeps, type BillingDeps } from "./billing/deps.js";

/* Global free-trial length (days). Stored in PlatformSetting, admin-editable. */
export const TRIAL_DAYS_KEY = "trial.days";
export const DEFAULT_TRIAL_DAYS = 14;

/* Global free-trial minute quota. The trial ends when EITHER limit (days or
 * minutes of call usage) is reached first. */
export const TRIAL_MINUTES_KEY = "trial.minutes";
export const DEFAULT_TRIAL_MINUTES = 10;

/* ------------------------------ Reporting FX ------------------------------ *
 *
 * Plans can be priced in more than one currency (AUD plans predate the USD
 * ones), and revenue figures were summing the raw `priceCents` across them —
 * A$89 + $299 came out as "388", which is not a number in any currency.
 *
 * USD is the reporting base. Rates are admin-editable rather than fetched live:
 * a dashboard that silently restates last month's MRR because the market moved
 * is worse than one that holds a rate someone chose and can explain.            */

export const FX_RATES_KEY = "fx.ratesToUsd";

/** Fallbacks used until an admin sets a rate. AUD/USD ≈ 0.71 (August 2026). */
export const DEFAULT_FX_RATES: Record<string, number> = { aud: 0.71 };

/** Currency every reported figure is normalised to. */
export const REPORTING_CURRENCY = "usd";

export type FxRates = Record<string, number>;

/**
 * Admin-set rates for converting each non-USD currency to USD.
 *
 * Stored as a JSON object keyed by lowercase currency code. Malformed or absent
 * settings fall back to the defaults rather than throwing — a bad value in one
 * row must not take the whole admin dashboard down.
 */
export async function getFxRates(): Promise<FxRates> {
  const row = await prisma.platformSetting.findUnique({ where: { key: FX_RATES_KEY } });
  if (!row?.value) return { ...DEFAULT_FX_RATES };
  try {
    const parsed = JSON.parse(row.value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...DEFAULT_FX_RATES };
    const out: FxRates = { ...DEFAULT_FX_RATES };
    for (const [code, rate] of Object.entries(parsed as Record<string, unknown>)) {
      const n = Number(rate);
      // A zero or negative rate would erase or invert revenue — ignore it and
      // keep the default, which is wrong by a little rather than by everything.
      if (Number.isFinite(n) && n > 0) out[code.toLowerCase()] = n;
    }
    return out;
  } catch {
    return { ...DEFAULT_FX_RATES };
  }
}

/**
 * Convert an amount to the reporting currency (USD).
 *
 * An unknown non-USD currency passes through unconverted — the same behaviour
 * as before this existed, so adding a currency without a rate can only be as
 * wrong as the old code was, never worse. `unconvertible` lets callers surface
 * that rather than quietly publishing a number nobody can source.
 */
export function toReportingCents(
  cents: number,
  currency: string,
  rates: FxRates,
): { cents: number; unconvertible: boolean } {
  const code = (currency || REPORTING_CURRENCY).toLowerCase();
  if (code === REPORTING_CURRENCY) return { cents, unconvertible: false };
  const rate = rates[code];
  if (!rate) return { cents, unconvertible: true };
  return { cents: cents * rate, unconvertible: false };
}

/*
 * Trial terms resolve brand-first: a white-label tenant may set its own days
 * and minutes, and everything else falls through to the platform setting.
 * The brand defaults to the AMBIENT one (the request's tenant, or the signed-in
 * account's — see lib/brandContext), so the many call sites in the trial
 * service need no threading; off-request work with no ambient brand gets the
 * platform's terms, which is what it always got. A brand override of 0 means
 * "no override", matching how a blank platform row is treated.
 */
export async function getTrialDays(
  brandId: string | null | undefined = currentBrandId(),
): Promise<number> {
  const own = cachedBrand(brandId)?.trialDays;
  if (typeof own === "number" && own > 0) return own;
  const row = await prisma.platformSetting.findUnique({ where: { key: TRIAL_DAYS_KEY } });
  return row ? Number(row.value) || DEFAULT_TRIAL_DAYS : DEFAULT_TRIAL_DAYS;
}

export async function getTrialMinutes(
  brandId: string | null | undefined = currentBrandId(),
): Promise<number> {
  const own = cachedBrand(brandId)?.trialMinutes;
  if (typeof own === "number" && own > 0) return own;
  const row = await prisma.platformSetting.findUnique({ where: { key: TRIAL_MINUTES_KEY } });
  return row ? Number(row.value) || DEFAULT_TRIAL_MINUTES : DEFAULT_TRIAL_MINUTES;
}

/* Post-trial grace period: when a trial ends and the user doesn't convert, hold
 * their assigned number for this many days before releasing it back to the pool.
 * On/off + length are admin-editable PlatformSettings; on by default. */
export const GRACE_ENABLED_KEY = "grace.enabled";
export const GRACE_DAYS_KEY = "grace.days";
export const DEFAULT_GRACE_ENABLED = true;
export const DEFAULT_GRACE_DAYS = 7;

export async function getGraceConfig(): Promise<{ enabled: boolean; days: number }> {
  const [enabledRow, daysRow] = await Promise.all([
    prisma.platformSetting.findUnique({ where: { key: GRACE_ENABLED_KEY } }),
    prisma.platformSetting.findUnique({ where: { key: GRACE_DAYS_KEY } }),
  ]);
  return {
    enabled: enabledRow ? enabledRow.value === "true" : DEFAULT_GRACE_ENABLED,
    days: daysRow ? Number(daysRow.value) || DEFAULT_GRACE_DAYS : DEFAULT_GRACE_DAYS,
  };
}

/**
 * End a trialing customer's trial early once they've used up their trial-minute
 * quota. Ending the Stripe trial charges the saved card and flips the sub to
 * active (a customer.subscription.updated webhook then syncs the status too).
 * The days-based limit is enforced by Stripe's own trial_period_days, so this
 * only covers the "minutes ran out first" case. Best-effort and a no-op unless
 * the user is actively trialing with a Stripe subscription AND has auto-renew on
 * — with auto-renew off we never auto-charge; the trial simply lapses (calls
 * frozen) and Stripe cancels it at period end.
 *
 * `deps` defaults to the real tenantDb/stripe singletons (see billing/deps.ts)
 * so every existing caller is unchanged; a test passes a plain object instead.
 */
export async function enforceTrialMinutes(
  userId: string,
  deps: BillingDeps = createBillingDeps(),
): Promise<void> {
  const db = await deps.tenantForUser(userId);
  const profile = await db.profile.findUnique({
    where: { userId },
    select: { subscriptionStatus: true, stripeSubscriptionId: true, autoRenew: true },
  });
  if (!profile || profile.subscriptionStatus !== "trialing" || !profile.stripeSubscriptionId) return;

  // Auto-renew OFF → never auto-charge. A trial that runs out of minutes with
  // auto-renew disabled must NOT convert to a paid plan: the user is already
  // blocked (calls frozen) by the entitlement's expired_minutes status, and
  // Stripe cancels the trial at its end via cancel_at_period_end — no charge.
  // Mirrors reconcileSubscription's guard so BOTH trial-end paths (minutes here,
  // date there) respect the user's auto-renew choice.
  if (!profile.autoRenew) return;

  const quota = await getTrialMinutes();
  if (quota <= 0) return; // defensive — quota is always ≥ 1 via admin validation

  const conversion = await db.conversion.findUnique({ where: { userId }, select: { id: true } });
  if (!conversion) return;

  const used = await db.callLog.aggregate({ where: { conversionId: conversion.id }, _sum: { durationSec: true } });
  const minutesUsed = (used._sum.durationSec ?? 0) / 60;
  if (minutesUsed < quota) return;

  try {
    await deps.endTrialNow(profile.stripeSubscriptionId);
    await db.profile.update({
      where: { userId },
      data: { subscriptionStatus: "active", trialEndsAt: null },
    });
  } catch {
    /* best-effort — the webhook or the next call will retry */
  }
}
