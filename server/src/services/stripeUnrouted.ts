import { Prisma, type StripeUnroutedEvent } from "@prisma/client";
import { prisma } from "../prisma.js";

// Stripe events whose customer no brand holds get parked here for the super admin to
// retry or dismiss. Stripe is always told "received" so it doesn't retry a kept payment.

/** The Stripe customer id an event is about, whatever object it carries. */
export function customerIdOf(object: unknown): string | null {
  const o = object as { customer?: string | { id?: string } | null } | null | undefined;
  const c = o?.customer;
  if (typeof c === "string") return c || null;
  if (c && typeof c === "object" && typeof c.id === "string") return c.id || null;
  return null;
}

/** The subscription id an event is about, when it carries one. */
export function subscriptionIdOf(object: unknown): string | null {
  const o = object as { object?: string; id?: string; subscription?: string | { id?: string } | null } | null;
  if (o?.object === "subscription" && typeof o.id === "string") return o.id;
  const s = o?.subscription;
  if (typeof s === "string") return s || null;
  if (s && typeof s === "object" && typeof s.id === "string") return s.id || null;
  return null;
}

/** Event types the webhook acts on. Anything else is neither routed nor
 *  parked — there is nothing to apply it to. */
export const ROUTED_EVENT_PREFIXES = [
  "customer.subscription.",
  "invoice.payment_succeeded",
  "charge.refunded",
] as const;

export function isRoutedEventType(type: string): boolean {
  return ROUTED_EVENT_PREFIXES.some((p) => type.startsWith(p));
}

/** Park an event. Idempotent on the Stripe event id — Stripe retries. */
export async function parkUnroutedEvent(
  event: { id: string; type: string; data: { object: unknown } },
  reason: string,
): Promise<StripeUnroutedEvent> {
  const payload = event as unknown as Prisma.InputJsonValue;
  return prisma.stripeUnroutedEvent.upsert({
    where: { stripeEventId: event.id },
    create: {
      stripeEventId: event.id,
      type: event.type,
      stripeCustomerId: customerIdOf(event.data.object),
      stripeSubscriptionId: subscriptionIdOf(event.data.object),
      payload,
      reason,
    },
    update: { reason, resolvedAt: null, resolution: null, resolvedById: null },
  });
}

export interface UnroutedEventView {
  id: string;
  stripeEventId: string;
  type: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  reason: string;
  receivedAt: string;
}

/** Everything still waiting, oldest first — the order to deal with them in. */
export async function listUnroutedEvents(limit = 100): Promise<UnroutedEventView[]> {
  const rows = await prisma.stripeUnroutedEvent.findMany({
    where: { resolvedAt: null },
    orderBy: { receivedAt: "asc" },
    take: Math.min(Math.max(limit, 1), 500),
  });
  return rows.map((r) => ({
    id: r.id,
    stripeEventId: r.stripeEventId,
    type: r.type,
    stripeCustomerId: r.stripeCustomerId,
    stripeSubscriptionId: r.stripeSubscriptionId,
    reason: r.reason,
    receivedAt: r.receivedAt.toISOString(),
  }));
}

export async function countUnroutedEvents(): Promise<number> {
  return prisma.stripeUnroutedEvent.count({ where: { resolvedAt: null } });
}

/** Mark a parked event dealt with: routed after a retry, or dismissed. */
export async function resolveUnroutedEvent(
  id: string,
  resolution: "routed" | "dismissed",
  resolvedById: string,
): Promise<void> {
  await prisma.stripeUnroutedEvent.update({
    where: { id },
    data: { resolvedAt: new Date(), resolution, resolvedById },
  });
}
