import type { Brand } from "@prisma/client";
import { prisma } from "../prisma.js";
import { tenantFor } from "./tenantDb.js";
import { brandOrigin } from "./brands.js";
import { sendTemplate } from "./email.js";
import { notify, notifyPlatformOwners } from "./notifications.js";
import { downgradeToCustomer } from "./brandLifecycle.js";

// The active-customer rule (docs/brand-as-customer-plan.md, phase 7). A brand keeps its Brand Admin status while it
// has at least one active customer — on a paid plan (active / past due) or a live trial; the owner's own account
// never counts. In the last 7 days of a month a brand with none is warned once; still none on the 7th of the next
// month and it is downgraded to its owner's main-domain customer account. A brand is first held to the rule in the
// first calendar month it was a brand for the whole of.
//
// Cost: one daily pass over the BRANDS only (not main-domain customers), one indexed count in each brand's database.

/** Days at the end of a month in which a brand with no active customer is warned. */
export const WARNING_DAYS = 7;
/** Day of the next month on which a warned brand that still has none is downgraded. */
export const DOWNGRADE_DAY = 7;

const PAID_STATUSES = ["active", "past_due", "trialing"];

/** "YYYY-MM" of the UTC month `d` falls in. */
export function periodOf(d: Date): string {
  return d.toISOString().slice(0, 7);
}

function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function daysInMonth(d: Date): number {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

/** True during the last WARNING_DAYS days of the month. */
export function inWarningWindow(now: Date): boolean {
  return now.getUTCDate() > daysInMonth(now) - WARNING_DAYS;
}

/** The downgrade date for a warning given in `period`, as a readable date. */
export function deadlineFor(period: string): Date {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, DOWNGRADE_DAY));
}

/** A brand's active customers right now, read live from its own database. */
export async function activeCustomerCount(brand: Pick<Brand, "id" | "ownerUserId">, now = new Date()): Promise<number> {
  const db = await tenantFor(brand.id);
  return db.profile.count({
    where: {
      suspendedAt: null,
      user: { role: "USER", ...(brand.ownerUserId ? { id: { not: brand.ownerUserId } } : {}) },
      OR: [
        { subscriptionStatus: { in: PAID_STATUSES } },
        { trialStartedAt: { not: null }, trialStatus: "active", trialEndsAt: { gt: now } },
      ],
    },
  });
}

export interface EligibilityResult {
  warned: string[];
  cleared: string[];
  downgraded: string[];
  failed: string[];
}

/** The daily pass. Each brand is independent: one unreachable database never stalls the rest. */
export async function runBrandEligibilityCheck(now = new Date()): Promise<EligibilityResult> {
  const out: EligibilityResult = { warned: [], cleared: [], downgraded: [], failed: [] };
  const period = periodOf(now);
  const previous = periodOf(new Date(monthStart(now).getTime() - 1));
  const warnNow = inWarningWindow(now);
  const downgradeNow = now.getUTCDate() >= DOWNGRADE_DAY;

  // Only brands held to the rule this month: a brand for the whole of it, with an owner to fall back to. Plus any
  // brand still carrying a warning, so a customer who became active since clears it.
  const brands = await prisma.brand.findMany({
    where: {
      kind: "brand",
      status: "active",
      ownerUserId: { not: null },
      OR: [{ brandSince: { lt: monthStart(now) } }, { statusWarnedFor: { not: "" } }],
    },
  });

  for (const brand of brands) {
    try {
      const warned = brand.statusWarnedFor;
      // Warned for an earlier month and the grace has run out: on/after the 7th for last month's warning, at once
      // for an older one (a missed run must not let a brand slip past the rule).
      const overdue = !!warned && warned < period && (warned < previous || downgradeNow);
      const mayWarn = warnNow && warned !== period && !!brand.brandSince && brand.brandSince < monthStart(now);
      if (!overdue && !mayWarn && !warned) continue;

      const active = await activeCustomerCount(brand, now);
      if (active > 0) {
        if (warned) {
          await prisma.brand.update({ where: { id: brand.id }, data: { statusWarnedFor: "" } });
          out.cleared.push(brand.slug);
        }
        continue;
      }

      if (overdue) {
        await downgradeToCustomer(brand.id, { reason: "no_active_customers" });
        out.downgraded.push(brand.slug);
        void notifyPlatformOwners({
          type: "system",
          title: `${brand.name} was downgraded`,
          message: "It had no active customers, so it is a main-domain customer account again.",
          link: "/dashboard/admin/platform-customers",
        });
        continue;
      }

      if (mayWarn) {
        await prisma.brand.update({ where: { id: brand.id }, data: { statusWarnedFor: period } });
        await warnOwner(brand, deadlineFor(period));
        out.warned.push(brand.slug);
      }
    } catch (e) {
      console.error(`[brand eligibility] ${brand.slug}:`, e);
      out.failed.push(brand.slug);
    }
  }
  return out;
}

async function warnOwner(brand: Brand, deadline: Date): Promise<void> {
  if (!brand.ownerUserId) return;
  const owner = await prisma.customerDirectory.findUnique({
    where: { brandId_userId: { brandId: brand.id, userId: brand.ownerUserId } },
    select: { email: true, fullName: true },
  });
  const when = deadline.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  if (owner) {
    void sendTemplate("brand_admin_status_warning", owner.email, {
      user_name: owner.fullName,
      brand_name: brand.name,
      deadline: when,
      brand_url: `${brandOrigin(brand) ?? ""}/dashboard/admin/customers`,
    }).catch(() => undefined);
  }
  void notify(brand.ownerUserId, {
    type: "system",
    title: "Keep your Brand Admin status",
    message: `${brand.name} has no active customers. Add one by ${when}, or the brand becomes a normal customer account.`,
    link: "/dashboard/admin/customers",
  });
}
