import { describe, it, expect, vi } from "vitest";

// After a downgrade a brand's row is a main-domain customer's again: only its owner may use it. Every other account
// in that database (the brand's customers and staff) is kept but refused on each request — from the brand cache.

const rows = new Map<string, Record<string, unknown>>([
  ["b_down", { id: "b_down", kind: "customer", ownerUserId: "owner" }],
  ["b_live", { id: "b_live", kind: "brand", ownerUserId: "owner2" }],
  ["b_new", { id: "b_new", kind: "customer", ownerUserId: null }],
]);
vi.mock("../services/brands.js", () => ({
  cachedBrand: (id: string | null | undefined) => (id ? (rows.get(id) ?? null) : null),
  isCustomerBrand: (b: { kind?: string } | null) => b?.kind === "customer",
}));
vi.mock("../prisma.js", () => ({ prisma: {} }));
vi.mock("../services/tenantDb.js", () => ({ tenantFor: vi.fn(), TenantUnavailableError: class extends Error {} }));

const { closedByDowngrade } = await import("./auth.js");

describe("closedByDowngrade", () => {
  it("lets the owner of a downgraded row through", () => {
    expect(closedByDowngrade("owner", "b_down")).toBe(false);
  });

  it("closes every other account in a downgraded row", () => {
    expect(closedByDowngrade("customer_of_old_brand", "b_down")).toBe(true);
  });

  it("never touches a live brand's accounts, or the platform's own people", () => {
    expect(closedByDowngrade("anyone", "b_live")).toBe(false);
    expect(closedByDowngrade("super", null)).toBe(false);
  });

  it("leaves a sign-up whose owner isn't stamped yet alone", () => {
    expect(closedByDowngrade("first_user", "b_new")).toBe(false);
  });
});
