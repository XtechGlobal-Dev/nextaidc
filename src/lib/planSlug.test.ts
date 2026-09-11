import { describe, it, expect } from "vitest";
import type { SubscriptionPlan } from "@/lib/api";
import { planSlug, planCardId, planAnalyticsParams, type PlanIdentity } from "./planSlug";

/* Plan slugs are the identity a GA4 report groups by, so the two things that
 * matter here are: a readable slug for every plan an admin can create, and
 * never two plans collapsing into one bucket. */

const plan = (over: Partial<PlanIdentity> = {}): PlanIdentity =>
  ({
    id: "cmp1abc",
    name: "starter",
    displayName: "Starter",
    priceCents: 4900,
    currency: "aud",
    interval: "month",
    ...over,
  }) as SubscriptionPlan;

describe("planSlug", () => {
  it("uses the plan's short key", () => {
    expect(planSlug(plan())).toBe("starter");
    expect(planSlug(plan({ name: "premium" }))).toBe("premium");
  });

  it("slugifies spaces, case and punctuation", () => {
    expect(planSlug(plan({ name: "Standard Plan" }))).toBe("standard-plan");
    expect(planSlug(plan({ name: "  Pro / Team!  " }))).toBe("pro-team");
    expect(planSlug(plan({ name: "Small_Business (AU)" }))).toBe("small-business-au");
  });

  it("falls back to the display name when there's no short key", () => {
    expect(planSlug(plan({ name: "", displayName: "Premium Plus" }))).toBe("premium-plus");
  });

  // An empty slug on two plans would silently merge them in the report — the id
  // is ugly but it keeps every plan its own bucket.
  it("falls back to the id when nothing slug-worthy is left", () => {
    expect(planSlug(plan({ name: "", displayName: "" }))).toBe("plan-cmp1abc");
    expect(planSlug(plan({ name: "★★★", displayName: "•••" }))).toBe("plan-cmp1abc");
  });
});

describe("planCardId", () => {
  it("prefixes the slug so the DOM id can't collide with other ids", () => {
    expect(planCardId(plan())).toBe("plan-card-starter");
  });
});

describe("planAnalyticsParams", () => {
  it("reports price in major units and normalises the currency", () => {
    expect(planAnalyticsParams(plan())).toEqual({
      plan_slug: "starter",
      plan_id: "cmp1abc",
      plan_name: "Starter",
      plan_price: 49,
      currency: "AUD",
      plan_interval: "month",
    });
  });

  it("defaults a missing currency to USD", () => {
    expect(planAnalyticsParams(plan({ currency: "" })).currency).toBe("USD");
  });
});
