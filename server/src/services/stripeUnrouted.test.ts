import { describe, it, expect, vi, beforeEach } from "vitest";

/* ------------------------------------------------------------------ *
 *  Parking Stripe events no brand holds: what an event is about, which
 *  events are worth parking, and that a parked event is kept once
 *  however many times Stripe retries it.
 * ------------------------------------------------------------------ */

const h = vi.hoisted(() => ({ upsert: vi.fn(), findMany: vi.fn(), update: vi.fn(), count: vi.fn() }));

vi.mock("../prisma.js", () => ({
  prisma: { stripeUnroutedEvent: { upsert: h.upsert, findMany: h.findMany, update: h.update, count: h.count } },
}));

const { customerIdOf, subscriptionIdOf, isRoutedEventType, parkUnroutedEvent, resolveUnroutedEvent } =
  await import("./stripeUnrouted.js");

beforeEach(() => {
  vi.clearAllMocks();
  h.upsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({ id: "p1", ...create }));
});

describe("what an event is about", () => {
  it("reads the customer whether Stripe sent an id or an expanded object", () => {
    expect(customerIdOf({ customer: "cus_1" })).toBe("cus_1");
    expect(customerIdOf({ customer: { id: "cus_2" } })).toBe("cus_2");
    expect(customerIdOf({ customer: null })).toBeNull();
    expect(customerIdOf({ customer_email: "x@y.z" })).toBeNull();
    expect(customerIdOf(null)).toBeNull();
  });

  it("reads the subscription from a subscription object or an invoice/charge that names one", () => {
    expect(subscriptionIdOf({ object: "subscription", id: "sub_1" })).toBe("sub_1");
    expect(subscriptionIdOf({ object: "invoice", id: "in_1", subscription: "sub_2" })).toBe("sub_2");
    expect(subscriptionIdOf({ object: "invoice", id: "in_1", subscription: { id: "sub_3" } })).toBe("sub_3");
    expect(subscriptionIdOf({ object: "charge", id: "ch_1" })).toBeNull();
  });

  // Only events the webhook would act on are routed and parked; the rest have
  // nothing to be applied to, so parking them would only be noise.
  it("knows which event types are acted on", () => {
    expect(isRoutedEventType("customer.subscription.updated")).toBe(true);
    expect(isRoutedEventType("invoice.payment_succeeded")).toBe(true);
    expect(isRoutedEventType("charge.refunded")).toBe(true);
    expect(isRoutedEventType("checkout.session.completed")).toBe(false);
    expect(isRoutedEventType("payment_intent.succeeded")).toBe(false);
  });
});

describe("parking", () => {
  it("keeps the whole event, keyed by Stripe's event id so a retry does not duplicate it", async () => {
    const event = {
      id: "evt_1",
      type: "invoice.payment_succeeded",
      data: { object: { object: "invoice", id: "in_1", customer: "cus_stranger", subscription: "sub_9" } },
    };
    await parkUnroutedEvent(event, "No brand holds this Stripe customer.");
    expect(h.upsert).toHaveBeenCalledWith({
      where: { stripeEventId: "evt_1" },
      create: expect.objectContaining({
        stripeEventId: "evt_1",
        type: "invoice.payment_succeeded",
        stripeCustomerId: "cus_stranger",
        stripeSubscriptionId: "sub_9",
        payload: event,
        reason: "No brand holds this Stripe customer.",
      }),
      update: { reason: "No brand holds this Stripe customer.", resolvedAt: null, resolution: null, resolvedById: null },
    });
  });

  it("marks a parked event dealt with, by whom and how", async () => {
    await resolveUnroutedEvent("p1", "routed", "u_super");
    expect(h.update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: expect.objectContaining({ resolution: "routed", resolvedById: "u_super", resolvedAt: expect.any(Date) }),
    });
  });
});
