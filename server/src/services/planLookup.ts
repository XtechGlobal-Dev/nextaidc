import type { SubscriptionPlan } from "@prisma/client";
import { prisma } from "../prisma.js";

/** Profile with its plan joined by hand — the profile is in the brand DB, the catalogue in the control plane, and Prisma can't join across the two. */
export async function withPlan<T extends { subscriptionPlanId: string | null }>(
  profile: T | null,
): Promise<(T & { subscriptionPlan: SubscriptionPlan | null }) | null> {
  if (!profile) return null;
  const subscriptionPlan = profile.subscriptionPlanId
    ? await prisma.subscriptionPlan.findUnique({ where: { id: profile.subscriptionPlanId } })
    : null;
  return { ...profile, subscriptionPlan };
}

/** The same, for a list — one catalogue read for every distinct plan named. */
export async function withPlans<T extends { subscriptionPlanId: string | null }>(
  profiles: T[],
): Promise<(T & { subscriptionPlan: SubscriptionPlan | null })[]> {
  const ids = [...new Set(profiles.map((p) => p.subscriptionPlanId).filter((id): id is string => !!id))];
  const plans = ids.length ? await prisma.subscriptionPlan.findMany({ where: { id: { in: ids } } }) : [];
  const byId = new Map(plans.map((p) => [p.id, p]));
  return profiles.map((p) => ({ ...p, subscriptionPlan: p.subscriptionPlanId ? (byId.get(p.subscriptionPlanId) ?? null) : null }));
}
