import { describe, it, expect, vi, beforeEach } from "vitest";

/* ------------------------------------------------------------------ *
 *  The Stripe customer index: how a payment finds its brand. Written
 *  when the customer is made, rebuilt from the profile that holds the
 *  id when it is missing, and honest when nobody holds it.
 * ------------------------------------------------------------------ */

const h = vi.hoisted(() => ({
  indexFindUnique: vi.fn(),
  indexUpsert: vi.fn(),
  profileFindFirst: vi.fn(),
  profileFindMany: vi.fn(),
}));

vi.mock("../prisma.js", () => ({
  prisma: {
    stripeCustomer: { findUnique: h.indexFindUnique, upsert: h.indexUpsert },
    profile: { findFirst: h.profileFindFirst, findMany: h.profileFindMany },
  },
}));
vi.mock("./tenantDb.js", async () =>
  (await import("../test/tenantDbFake.js")).tenantDbFake({}),
);
vi.mock("./stripe.js", () => ({ isStripeConfigured: () => false, stripe: vi.fn() }));

const { indexStripeCustomer, resolveStripeCustomer, backfillStripeCustomerIndex, stripeOwnerMetadata } =
  await import("./stripeCustomers.js");

beforeEach(() => {
  vi.clearAllMocks();
  h.indexFindUnique.mockResolvedValue(null);
  h.profileFindFirst.mockResolvedValue(null);
  h.indexUpsert.mockResolvedValue({});
});

describe("indexStripeCustomer", () => {
  it("remembers which brand and account a Stripe customer belongs to", async () => {
    await indexStripeCustomer("cus_1", { brandId: "b_acme", userId: "u1" });
    expect(h.indexUpsert).toHaveBeenCalledWith({
      where: { stripeCustomerId: "cus_1" },
      create: { stripeCustomerId: "cus_1", brandId: "b_acme", userId: "u1" },
      update: { brandId: "b_acme", userId: "u1" },
    });
  });

  // The platform's own people have no brand — there is nothing to route to.
  it("skips an account with no brand, and an empty id", async () => {
    await indexStripeCustomer("cus_1", { brandId: null, userId: "u_super" });
    await indexStripeCustomer("", { brandId: "b_acme", userId: "u1" });
    expect(h.indexUpsert).not.toHaveBeenCalled();
  });

  it("stamps the same two facts on the Stripe object", () => {
    expect(stripeOwnerMetadata({ brandId: "b_acme", userId: "u1" })).toEqual({ brandId: "b_acme", userId: "u1" });
    expect(stripeOwnerMetadata({ brandId: null, userId: "u_super" })).toEqual({});
  });
});

describe("resolveStripeCustomer", () => {
  it("answers from the index", async () => {
    h.indexFindUnique.mockResolvedValue({ stripeCustomerId: "cus_1", brandId: "b_acme", userId: "u1" });
    expect(await resolveStripeCustomer("cus_1")).toEqual({ brandId: "b_acme", userId: "u1" });
    expect(h.profileFindFirst).not.toHaveBeenCalled();
  });

  // Customers from before the index existed: the profile still holds the id,
  // and the index is repaired on the way out so the next event is one lookup.
  it("falls back to the profile holding the id, and repairs the index", async () => {
    h.profileFindFirst.mockResolvedValue({ userId: "u1", user: { brandId: "b_acme" } });
    expect(await resolveStripeCustomer("cus_old")).toEqual({ brandId: "b_acme", userId: "u1" });
    expect(h.profileFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ stripeCustomerId: "cus_old" }, { pendingSwitchCustomerId: "cus_old" }] },
      }),
    );
    expect(h.indexUpsert).toHaveBeenCalledWith(expect.objectContaining({ where: { stripeCustomerId: "cus_old" } }));
  });

  it("says so when no brand holds the customer — never guesses", async () => {
    expect(await resolveStripeCustomer("cus_stranger")).toBeNull();
    expect(await resolveStripeCustomer(null)).toBeNull();
    expect(h.indexUpsert).not.toHaveBeenCalled();
  });

});

describe("backfillStripeCustomerIndex", () => {
  it("indexes every customer id a brand's profiles hold, including one mid-switch", async () => {
    h.profileFindMany.mockResolvedValue([
      { userId: "u1", stripeCustomerId: "cus_1", pendingSwitchCustomerId: "cus_1_aud", user: { brandId: "b_acme" } },
    ]);
    expect(await backfillStripeCustomerIndex()).toBe(2);
    expect(h.indexUpsert).toHaveBeenCalledTimes(2);
  });
});
