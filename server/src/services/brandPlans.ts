import { prisma } from "../prisma.js";
import { badRequest } from "../lib/http.js";
import { tenantFor, TenantUnavailableError } from "./tenantDb.js";

// Which platform plans a brand may sell is the super admin's pick (Brand.planIds) — but a plan the
// brand's customers are already on can't be taken away, or they'd lose the plan they pay for.

/** Statuses that count as "still on the plan". Mirrors LIVE_SUB_STATUSES in admin.routes. */
const LIVE_SUB_STATUSES = ["trialing", "active", "past_due"];

/** How many of this brand's customers are live on each plan, by plan id. A brand with no database yet has no customers. */
export async function livePlanSubscribers(brandId: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let db;
  try {
    db = await tenantFor(brandId);
  } catch (e) {
    if (e instanceof TenantUnavailableError) return out;
    throw e;
  }
  const rows = await db.profile.groupBy({
    by: ["subscriptionPlanId"],
    where: { subscriptionStatus: { in: LIVE_SUB_STATUSES }, subscriptionPlanId: { not: null } },
    _count: { _all: true },
  });
  for (const r of rows) if (r.subscriptionPlanId) out.set(r.subscriptionPlanId, r._count._all);
  return out;
}

/** Refuses a pick that drops a plan the brand's customers are on. Empty means "every plan" and is always fine. */
export async function assertPickKeepsSubscribedPlans(
  brandId: string,
  planIds: string[] | null | undefined,
): Promise<void> {
  if (!planIds || planIds.length === 0) return;
  const live = await livePlanSubscribers(brandId);
  const missing = [...live.keys()].filter((id) => !planIds.includes(id));
  if (!missing.length) return;
  const plans = await prisma.subscriptionPlan.findMany({
    where: { id: { in: missing } },
    select: { id: true, displayName: true },
  });
  const names = missing.map((id) => plans.find((p) => p.id === id)?.displayName ?? id);
  throw badRequest(
    `Customers of this brand are on ${names.join(", ")} — keep ${names.length === 1 ? "that plan" : "those plans"} offered.`,
  );
}
