import { prisma } from "../prisma.js";
import { tenantForUser } from "./tenantDb.js";

/** Subscription lifecycle moments for the Admin → Subscriptions timeline. Stored in the customer's brand DB. */
export type PlanEventType =
  | "trial_started"
  | "trial_converted"
  | "upgraded"
  | "downgrade_scheduled"
  | "downgraded"
  | "downgrade_canceled"
  | "plan_switched"
  | "renewed"
  | "canceled"
  | "auto_renew_off"
  | "auto_renew_on"
  | "coupon_applied"
  | "coupon_expired"
  | "coupon_reattached";

export interface PlanEventInput {
  userId: string;
  type: PlanEventType;
  fromPlanId?: string | null;
  fromPlanName?: string | null;
  toPlanId?: string | null;
  toPlanName?: string | null;
  /** Destination plan's recurring price; resolved from `toPlanId` when omitted. */
  priceCents?: number;
  currency?: string;
  /** Money actually charged for this event (0 for free transitions). */
  amountCents?: number;
  note?: string;
}

/** Records a plan event. Never throws (history must not break the billing action); names are denormalized so the row survives plan rename/deletion. */
export async function recordPlanEvent(e: PlanEventInput): Promise<void> {
  try {
    let fromPlanName = e.fromPlanName ?? null;
    let toPlanName = e.toPlanName ?? null;
    let priceCents = e.priceCents;
    let currency = e.currency;

    // Resolve whatever the caller didn't pass from the plan ids (one query for both).
    const idsToResolve = [
      ...(e.fromPlanId && !fromPlanName ? [e.fromPlanId] : []),
      ...(e.toPlanId && (!toPlanName || priceCents === undefined || !currency) ? [e.toPlanId] : []),
    ];
    if (idsToResolve.length > 0) {
      const plans = await prisma.subscriptionPlan.findMany({
        where: { id: { in: idsToResolve } },
        select: { id: true, displayName: true, priceCents: true, currency: true },
      });
      const byId = new Map(plans.map((p) => [p.id, p]));
      const from = e.fromPlanId ? byId.get(e.fromPlanId) : undefined;
      const to = e.toPlanId ? byId.get(e.toPlanId) : undefined;
      if (!fromPlanName && from) fromPlanName = from.displayName;
      if (to) {
        if (!toPlanName) toPlanName = to.displayName;
        if (priceCents === undefined) priceCents = to.priceCents;
        if (!currency) currency = to.currency;
      }
    }

    const db = await tenantForUser(e.userId);
    await db.planEvent.create({
      data: {
        userId: e.userId,
        type: e.type,
        fromPlanId: e.fromPlanId ?? null,
        fromPlanName,
        toPlanId: e.toPlanId ?? null,
        toPlanName,
        priceCents: priceCents ?? 0,
        currency: currency ?? "usd",
        amountCents: e.amountCents ?? 0,
        note: e.note ?? "",
      },
    });
  } catch {
    /* plan history must never break the billing action it records */
  }
}
