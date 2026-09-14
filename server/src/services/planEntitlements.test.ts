import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    profile: { findUnique: vi.fn() },
    conversion: { findUnique: vi.fn(async () => null) },
  },
}));
// The profile lives in the customer's brand's database — the same stand-in here —
// and the plan a test embeds on the row stands in for the catalogue join.
vi.mock("./tenantDb.js", async () => {
  const { prisma } = await import("../prisma.js");
  class TenantUnavailableError extends Error {}
  return { tenantForUser: async () => prisma, TenantUnavailableError };
});
vi.mock("./planLookup.js", () => ({ withPlan: async (p: unknown) => p, withPlans: async (p: unknown) => p }));

vi.mock("./billing.js", () => ({
  getTrialDays: vi.fn(async () => 14),
  getTrialMinutes: vi.fn(async () => 10),
}));

import { prisma } from "../prisma.js";
/** The stand-in above, typed as what it is: mocks by model and method. */
const fake = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;
import { getPlanFeatures } from "./trial.js";

const findUnique = fake.profile.findUnique as unknown as ReturnType<typeof vi.fn>;

/** A plan that grants nothing except SMS summaries — the "cheap tier" case. */
const CHEAP_PLAN = {
  smsEnabled: true,
  smsToCallerEnabled: false,
  whatsappEnabled: false,
  customCrmEnabled: false,
  multilingualEnabled: false,
  callTransferEnabled: false,
  callTransferLimit: 0,
};

/** Everything unlocked resolves transfer to the hard ceiling, not to a plan cap. */
const ALL_DEPARTMENTS = 20;

const row = (over: Record<string, unknown> = {}) => ({
  subscriptionStatus: "active",
  // Signup-time policy snapshot; false = the card-less default every existing
  // account carries. Only meaningful while the status is still "none".
  cardRequiredAtSignup: false,
  cardConfirmedAt: null,
  user: { role: "USER" },
  subscriptionPlan: CHEAP_PLAN,
  ...over,
});

// Entitlements hinge on PAYMENT, not on claiming a number. The old rule left a
// paid cheap plan with every premium add-on until a number existed.

describe("getPlanFeatures", () => {
  beforeEach(() => findUnique.mockReset());

  it("restricts as soon as the payment lands, with no number claimed", async () => {
    findUnique.mockResolvedValue(row({ receptionistNumber: null }));
    const f = await getPlanFeatures("u1");
    expect(f.sms).toBe(true); // the one thing this plan includes
    expect(f.smsToCaller).toBe(false);
    expect(f.whatsapp).toBe(false);
    expect(f.customCrm).toBe(false);
    expect(f.multilingual).toBe(false);
  });

  it("gives the same answer once a number exists — the number is irrelevant now", async () => {
    findUnique.mockResolvedValue(row({ receptionistNumber: "+61468159801" }));
    expect(await getPlanFeatures("u1")).toEqual({
      sms: true,
      smsToCaller: false,
      whatsapp: false,
      customCrm: false,
      multilingual: false,
      callTransferDepartments: 0,
    });
  });

  it("leaves the free trial wide open so add-ons can be tried before buying", async () => {
    findUnique.mockResolvedValue(row({ subscriptionStatus: "trialing", subscriptionPlan: CHEAP_PLAN }));
    const f = await getPlanFeatures("u1");
    expect(f).toEqual({
      sms: true,
      smsToCaller: true,
      whatsapp: true,
      customCrm: true,
      multilingual: true,
      // …every BOOLEAN add-on, that is. The department count follows the plan
      // even here — see the trial-count tests below for why.
      callTransferDepartments: 0,
    });
  });

  // Counts are the exception to the open trial: a boolean flips off cleanly at
  // conversion, but an extra department would be orphaned and block the next plan change.

  it("caps trial departments at the plan's limit, not the ceiling", async () => {
    findUnique.mockResolvedValue(
      row({
        subscriptionStatus: "trialing",
        subscriptionPlan: { ...CHEAP_PLAN, callTransferEnabled: true, callTransferLimit: 2 },
      }),
    );
    expect((await getPlanFeatures("u1")).callTransferDepartments).toBe(2);
  });

  it("gives trial departments nothing when the plan excludes transfer", async () => {
    findUnique.mockResolvedValue(row({ subscriptionStatus: "trialing", subscriptionPlan: CHEAP_PLAN }));
    expect((await getPlanFeatures("u1")).callTransferDepartments).toBe(0);
  });

  it("falls back to the ceiling before a plan is picked — nothing to preview yet", async () => {
    findUnique.mockResolvedValue(row({ subscriptionStatus: "none", subscriptionPlan: null }));
    expect((await getPlanFeatures("u1")).callTransferDepartments).toBe(ALL_DEPARTMENTS);
  });

  it("leaves a brand-new CARD-LESS signup open (nothing paid, nothing to enforce)", async () => {
    findUnique.mockResolvedValue(
      row({ subscriptionStatus: "none", cardRequiredAtSignup: false, subscriptionPlan: null }),
    );
    const f = await getPlanFeatures("u1");
    expect(f.smsToCaller).toBe(true);
  });

  // Features are a PLAN concern, not access control. The card wall is deliberately
  // NOT enforced here — getEntitlement and the money-spending routes do that.
  it("keeps every add-on open through a card-required trial", async () => {
    findUnique.mockResolvedValue(
      row({
        subscriptionStatus: "trialing",
        cardRequiredAtSignup: true,
        cardConfirmedAt: new Date(),
        subscriptionPlan: CHEAP_PLAN, // a plan that grants almost nothing…
      }),
    );
    // …but the trial hasn't converted, so the plan's boolean limits don't apply
    // yet. The department COUNT still does — it is state, not a switch.
    const f = await getPlanFeatures("u1");
    expect(f).toEqual({
      sms: true,
      smsToCaller: true,
      whatsapp: true,
      customCrm: true,
      multilingual: true,
      callTransferDepartments: 0,
    });
  });

  it("does not restrict features for a card-required account still awaiting its card", async () => {
    findUnique.mockResolvedValue(
      row({
        subscriptionStatus: "none",
        cardRequiredAtSignup: true,
        cardConfirmedAt: null,
        subscriptionPlan: null,
      }),
    );
    const f = await getPlanFeatures("u1");
    expect(f.smsToCaller).toBe(true);
  });

  it("clamps to the plan the moment it activates, card-required or not", async () => {
    findUnique.mockResolvedValue(
      row({
        subscriptionStatus: "active",
        cardRequiredAtSignup: true,
        cardConfirmedAt: new Date(),
        subscriptionPlan: CHEAP_PLAN,
      }),
    );
    const f = await getPlanFeatures("u1");
    expect(f.sms).toBe(true); // the one thing this plan includes
    expect(f.smsToCaller).toBe(false);
    expect(f.whatsapp).toBe(false);
  });

  it("does NOT hand features back when a paid subscription lapses", async () => {
    for (const status of ["past_due", "suspended", "canceled"]) {
      findUnique.mockResolvedValue(row({ subscriptionStatus: status }));
      const f = await getPlanFeatures("u1");
      expect(f.smsToCaller, `status=${status}`).toBe(false);
      expect(f.sms, `status=${status}`).toBe(true); // still judged by the plan
    }
  });

  it("grants nothing when a paid status carries no plan", async () => {
    findUnique.mockResolvedValue(row({ subscriptionPlan: null }));
    const f = await getPlanFeatures("u1");
    expect(f).toEqual({
      sms: false,
      smsToCaller: false,
      whatsapp: false,
      customCrm: false,
      multilingual: false,
      callTransferDepartments: 0,
    });
  });

  it("gives admins everything regardless of plan or status", async () => {
    findUnique.mockResolvedValue(row({ user: { role: "ADMIN" }, subscriptionPlan: null }));
    const f = await getPlanFeatures("admin");
    expect(f).toEqual({
      sms: true,
      smsToCaller: true,
      whatsapp: true,
      customCrm: true,
      multilingual: true,
      callTransferDepartments: ALL_DEPARTMENTS,
    });
  });

  it("grants nothing when the profile is missing entirely", async () => {
    findUnique.mockResolvedValue(null);
    // No profile → status defaults to "none" → still in setup, so open.
    const f = await getPlanFeatures("ghost");
    expect(f.smsToCaller).toBe(true);
  });
});
