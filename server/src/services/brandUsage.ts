import type { Brand, BrandBilling, BrandUsageMonthly } from "@prisma/client";
import { prisma } from "../prisma.js";
import { brandIdForOwner } from "./customerDirectory.js";
import { cachedBrand, loadBrands } from "./brands.js";
import { brandOwesPlatform, brandServiceHold, type ServiceHold } from "./brandSetup.js";
import { tenantFor } from "./tenantDb.js";
import { notifyIn, notifyPlatformOwners, type NotificationInput } from "./notifications.js";
import { sendTemplate } from "./email.js";
import { runWithBrand } from "../lib/brandContext.js";

// Brand-wide monthly usage: billed call minutes and AI interactions summed across every customer of a
// brand, per UTC calendar month. Metered for every brand (the analytics page reads it), enforced only
// where the super admin set a cap. The enforcement itself is `serviceHold` on the brand: getEntitlement
// reads it from the brand cache, so a brand over its cap blocks its customers' AI through the same path
// an exhausted plan does — no extra query per call.

/** Days a brand may go without paying before its AI is paused. The admin panel is locked sooner. */
export const BRAND_BILLING_GRACE_DAYS = 14;
const GRACE_MS = BRAND_BILLING_GRACE_DAYS * 24 * 60 * 60 * 1000;

/** "2026-09" — the UTC month a moment falls in. */
export function usagePeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** When the current month's counters start again. */
export function nextPeriodStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/* -------------------------------- Holds -------------------------------- */

/** Has the brand gone too long without paying? Only brands that owe the platform anything can lapse. */
export function billingLapsed(
  brand: Pick<Brand, "platformFeeCents" | "purchasedFeatures">,
  billing: Pick<BrandBilling, "status" | "requiredSince" | "pastDueSince"> | null,
  now: Date = new Date(),
): boolean {
  if (!brandOwesPlatform(brand as Brand) || !billing) return false;
  const since = (d: Date | null) => now.getTime() - (d ?? now).getTime() > GRACE_MS;
  switch (billing.status) {
    case "active":
      return false;
    case "awaiting_card":
      return since(billing.requiredSince);
    default: // past_due, canceled
      return since(billing.pastDueSince ?? billing.requiredSince);
  }
}

/** Is the brand locked out of its admin panel until it pays? Never paid = at once; a failed renewal
 *  only once the grace period is over (Stripe is still retrying until then). */
export function billingLocked(
  brand: Pick<Brand, "platformFeeCents" | "purchasedFeatures">,
  billing: Pick<BrandBilling, "status" | "requiredSince" | "pastDueSince"> | null,
  now: Date = new Date(),
): boolean {
  if (!brandOwesPlatform(brand as Brand) || !billing) return false;
  if (billing.status === "awaiting_card") return true;
  return billingLapsed(brand, billing, now);
}

/** Why the brand's AI should be paused right now. Billing outranks the AI cap, which outranks minutes
 *  (it stops strictly more). Pure — the caller supplies this month's usage row. */
export function computeServiceHold(
  brand: Pick<Brand, "platformFeeCents" | "purchasedFeatures" | "monthlyMinuteLimit" | "monthlyAiLimit">,
  billing: Pick<BrandBilling, "status" | "requiredSince" | "pastDueSince"> | null,
  usage: Pick<BrandUsageMonthly, "minutes" | "aiInteractions"> | null,
  now: Date = new Date(),
): ServiceHold {
  if (billingLapsed(brand, billing, now)) return "billing";
  const ai = usage?.aiInteractions ?? 0;
  const minutes = usage?.minutes ?? 0;
  if (brand.monthlyAiLimit != null && ai >= brand.monthlyAiLimit) return "ai";
  if (brand.monthlyMinuteLimit != null && minutes >= brand.monthlyMinuteLimit) return "minutes";
  return "";
}

const HOLD_COPY: Record<Exclude<ServiceHold, "">, { title: string; message: string }> = {
  minutes: {
    title: "Monthly call minutes used up",
    message: "Your customers' AI has stopped answering calls until the minutes reset or the limit is raised.",
  },
  ai: {
    title: "Monthly AI interactions used up",
    message: "Your customers' AI is paused on every channel until the count resets or the limit is raised.",
  },
  billing: {
    title: "AI paused — payment overdue",
    message: "Your platform subscription hasn't been paid, so your customers' AI is paused. Pay from Billing to restore it.",
  },
};

/** Recomputes the brand's hold and, when it changes, writes it, repaints the cache and re-points every
 *  customer's number (detached while held, restored after). Idempotent; safe to call from anywhere. */
export async function refreshServiceHold(brandId: string, now: Date = new Date()): Promise<ServiceHold> {
  const brand = await prisma.brand.findUnique({ where: { id: brandId }, include: { billing: true } });
  if (!brand) return "";
  const usage = await prisma.brandUsageMonthly.findUnique({
    where: { brandId_period: { brandId, period: usagePeriod(now) } },
  });
  const next = computeServiceHold(brand, brand.billing, usage, now);
  const prev = brandServiceHold(brand);
  if (next === prev) return next;

  await prisma.brand.update({ where: { id: brandId }, data: { serviceHold: next } });
  await loadBrands();
  void resyncBrandCallCaps(brandId);

  const copy = next
    ? HOLD_COPY[next]
    : { title: "AI service restored", message: `${brand.name}'s AI is answering again.` };
  void alertBrand(brandId, brand.name, { type: "billing", ...copy });
  return next;
}

/** Re-points every customer's number at (or away from) their assistant after the brand's hold changed.
 *  Sequential and best-effort: one Vapi hiccup must not leave the rest of the brand stuck. */
export async function resyncBrandCallCaps(brandId: string): Promise<void> {
  try {
    const db = await tenantFor(brandId);
    const rows = await db.conversion.findMany({
      where: { vapiAssistantId: { not: null } },
      select: { userId: true },
    });
    // Lazy: provisioning pulls in the whole Vapi stack.
    const { syncAssistantCallCap } = await import("./provisioning.js");
    for (const r of rows) {
      await runWithBrand(brandId, () => syncAssistantCallCap(r.userId)).catch((e: unknown) =>
        console.warn(`[brand-usage] call-cap resync failed for ${r.userId}:`, e),
      );
    }
  } catch (e) {
    console.warn(`[brand-usage] could not resync brand ${brandId}:`, e);
  }
}

/** Every brand the hold could apply to: re-evaluated hourly, which is what lifts a cap when the month
 *  turns over and pauses a brand whose grace period just ran out. */
export async function refreshAllServiceHolds(now: Date = new Date()): Promise<void> {
  const brands = await prisma.brand.findMany({
    where: {
      OR: [
        { platformFeeCents: { gt: 0 } },
        { monthlyMinuteLimit: { not: null } },
        { monthlyAiLimit: { not: null } },
        { serviceHold: { not: "" } },
        { NOT: { purchasedFeatures: { equals: [] } } },
      ],
    },
    select: { id: true, platformFeeCents: true },
  });
  for (const b of brands) {
    try {
      // A fee set on an existing brand starts its grace clock here if nothing else has.
      if (b.platformFeeCents > 0) await ensureBillingRow(b.id);
      await refreshServiceHold(b.id, now);
    } catch (e) {
      console.warn(`[brand-usage] hold refresh failed for ${b.id}:`, e);
    }
  }
}

/** The billing row, created on first need. Its `requiredSince` is the grace clock, so it's only ever
 *  created — never reset — here. */
export async function ensureBillingRow(brandId: string): Promise<BrandBilling> {
  return prisma.brandBilling.upsert({ where: { brandId }, create: { brandId }, update: {} });
}

/* -------------------------------- Metering ------------------------------- */

/** One finished call: its billed minutes (rounded up, like a customer's) plus one AI interaction. */
export async function meterCall(userId: string, seconds: number): Promise<void> {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  await meter(userId, { minutes: Math.ceil(seconds / 60), ai: 1 });
}

/** One AI action outside a call's own minutes — a text to a caller, a WhatsApp reply, a booking action. */
export async function meterAiInteraction(userId: string): Promise<void> {
  await meter(userId, { minutes: 0, ai: 1 });
}

/** May this customer's AI act on a text channel right now? False only when their brand is paused for
 *  AI (cap or billing). Customers without a brand are never limited here. */
export async function aiAllowedFor(userId: string): Promise<boolean> {
  const hold = brandServiceHold(cachedBrand(await brandIdForOwner(userId)));
  return hold === "" || hold === "minutes";
}

async function meter(userId: string, add: { minutes: number; ai: number }): Promise<void> {
  try {
    const brandId = await brandIdForOwner(userId);
    const brand = cachedBrand(brandId);
    if (!brandId || !brand) return;
    const period = usagePeriod();
    const row = await prisma.brandUsageMonthly.upsert({
      where: { brandId_period: { brandId, period } },
      create: { brandId, period, minutes: add.minutes, aiInteractions: add.ai },
      update: { minutes: { increment: add.minutes }, aiInteractions: { increment: add.ai } },
    });
    await checkThresholds(brand, row);
  } catch (e) {
    // Metering must never break the call or message it counts.
    console.warn("[brand-usage] metering failed:", e);
  }
}

/** Alert level a count has reached against a cap: 0, 80 or 100. */
export function alertLevel(used: number, limit: number | null): 0 | 80 | 100 {
  if (limit == null) return 0;
  if (limit === 0 || used >= limit) return 100;
  return used >= limit * 0.8 ? 80 : 0;
}

async function checkThresholds(brand: Brand, row: BrandUsageMonthly): Promise<void> {
  const metrics = [
    { key: "minutesAlerted", used: row.minutes, limit: brand.monthlyMinuteLimit, label: "call minutes", alerted: row.minutesAlerted },
    { key: "aiAlerted", used: row.aiInteractions, limit: brand.monthlyAiLimit, label: "AI interactions", alerted: row.aiAlerted },
  ] as const;
  let reachedCap = false;
  for (const m of metrics) {
    const level = alertLevel(m.used, m.limit);
    if (level === 100) reachedCap = true;
    if (level <= m.alerted) continue;
    // Conditional write: of two calls crossing the line together, only one sends the alert.
    const { count } = await prisma.brandUsageMonthly.updateMany({
      where: { brandId: row.brandId, period: row.period, [m.key]: { lt: level } },
      data: { [m.key]: level },
    });
    if (count === 0 || level !== 80) continue; // 100% is announced by the hold itself
    void alertBrand(
      brand.id,
      brand.name,
      {
        type: "billing",
        title: `80% of monthly ${m.label} used`,
        message: `${m.used.toLocaleString("en-US")} of ${m.limit!.toLocaleString("en-US")} ${m.label} used this month.`,
      },
      { metric: m.label, used: m.used, limit: m.limit! },
    );
  }
  if (reachedCap) await refreshServiceHold(brand.id);
}

/** Tells the brand's admins (in-app and by email) and the platform's owners (in-app). Best-effort. */
export async function alertBrand(
  brandId: string,
  brandName: string,
  n: NotificationInput,
  usage?: { metric: string; used: number; limit: number },
): Promise<void> {
  try {
    const tenant = await tenantFor(brandId);
    const admins = await tenant.user.findMany({ where: { role: "ADMIN" }, select: { id: true, email: true, fullName: true } });
    await notifyIn(tenant, admins.map((a) => a.id), { ...n, link: "/dashboard/admin/billing" });
    await notifyPlatformOwners({
      ...n,
      title: `${brandName}: ${n.title}`,
      link: `/dashboard/admin/brands/${brandId}?tab=billing`,
    });
    for (const a of admins) {
      // Inside the brand, so the mail wears the brand's name and sender.
      await runWithBrand(brandId, () =>
        sendTemplate("brand_service_alert", a.email, {
          user_name: a.fullName,
          brand_name: brandName,
          alert_title: n.title,
          alert_message: n.message ?? "",
          usage_line: usage ? `${usage.used.toLocaleString("en-US")} of ${usage.limit.toLocaleString("en-US")} ${usage.metric} used this month.` : "",
        }),
      ).catch(() => false);
    }
  } catch {
    /* alerts are best-effort */
  }
}

/* -------------------------------- Reading -------------------------------- */

export interface BrandUsageSummary {
  period: string;
  resetsAt: string;
  minutes: number;
  minutesLimit: number | null;
  aiInteractions: number;
  aiLimit: number | null;
  hold: ServiceHold;
}

export async function brandUsageSummary(brand: Brand, now: Date = new Date()): Promise<BrandUsageSummary> {
  const period = usagePeriod(now);
  const row = await prisma.brandUsageMonthly.findUnique({ where: { brandId_period: { brandId: brand.id, period } } });
  return {
    period,
    resetsAt: nextPeriodStart(now).toISOString(),
    minutes: row?.minutes ?? 0,
    minutesLimit: brand.monthlyMinuteLimit,
    aiInteractions: row?.aiInteractions ?? 0,
    aiLimit: brand.monthlyAiLimit,
    hold: brandServiceHold(brand),
  };
}

/** The last `months` months of usage, oldest first, zero-filled. */
export async function brandUsageHistory(brandId: string, months = 6, now: Date = new Date()) {
  const periods: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    periods.push(usagePeriod(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
  }
  const rows = await prisma.brandUsageMonthly.findMany({ where: { brandId, period: { in: periods } } });
  const byPeriod = new Map(rows.map((r) => [r.period, r]));
  return periods.map((period) => ({
    period,
    minutes: byPeriod.get(period)?.minutes ?? 0,
    aiInteractions: byPeriod.get(period)?.aiInteractions ?? 0,
  }));
}
