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

// Reporting FX. Plans exist in AUD and USD and revenue used to sum raw priceCents across both.
// USD is the base; rates are admin-set, not live, so last month's MRR doesn't silently restate itself.

export const FX_RATES_KEY = "fx.ratesToUsd";

/** Fallbacks used until an admin sets a rate. AUD/USD ≈ 0.71 (August 2026). */
export const DEFAULT_FX_RATES: Record<string, number> = { aud: 0.71 };

/** Currency every reported figure is normalised to. */
export const REPORTING_CURRENCY = "usd";

export type FxRates = Record<string, number>;

/** Admin-set rates to USD, keyed by lowercase code. Malformed settings fall back to defaults — one bad row must not take the dashboard down. */
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

/** Converts to USD. An unknown currency passes through unconverted with `unconvertible` set so callers can flag it instead of publishing a number nobody can source. */
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

// Brand override first, platform setting as fallback. brandId defaults to the
// ambient one so callers don't thread it; a brand value of 0 means "no override".
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

// Post-trial grace: hold an unconverted user's number this many days before releasing it. Admin-editable, on by default.
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

/** Ends a trial early once its minute quota is spent. Only the "minutes ran out first" case — days are Stripe's job — and never with auto-renew off (no surprise charges). `deps` is injectable for tests. */
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

  // Auto-renew off must never convert to paid: calls are already frozen and Stripe cancels at
  // period end. Mirrors reconcileSubscription's guard so both trial-end paths agree.
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
