import { describe, it, expect } from "vitest";
import { onboardingRedirectPath, ONBOARDING_PRICING_STEP, STAFF_NO_ACCESS_PATH } from "./onboardingRoute";
import type { AuthUser } from "@/lib/api";
import type { Profile } from "@/types";

/* Where a user lands after login. This is the client-side card wall: it has to
 * beat the "onboarding already complete" short-circuit, because a direct signup
 * is stamped complete at account CREATION — so onboarding state alone could never
 * hold the wall. */

const user = (profile: Partial<Profile> | null, role: AuthUser["role"] = "USER"): AuthUser =>
  ({
    id: "u1",
    email: "a@b.com",
    fullName: "A B",
    role,
    permissions: [],
    plan: "free",
    profile: profile as Profile | null,
  }) as AuthUser;

const DONE = "2026-01-01T00:00:00.000Z";

describe("onboardingRedirectPath — the card wall", () => {
  it("sends a card-required direct signup to /subscribe despite onboarding being stamped complete", () => {
    // The abandon-at-the-card-step case. A direct (non-funnel) signup gets
    // onboardingCompletedAt set at creation, so the old rule short-circuited
    // every one of them straight to the dashboard.
    expect(
      onboardingRedirectPath(
        user({
          cardRequiredAtSignup: true,
          cardConfirmedAt: null,
          subscriptionStatus: "none",
          onboardingStep: 0,
          onboardingCompletedAt: DONE,
        }),
      ),
    ).toBe("/subscribe");
  });

  it("lets a card-required guided signup finish the funnel first", () => {
    expect(
      onboardingRedirectPath(
        user({
          cardRequiredAtSignup: true,
          cardConfirmedAt: null,
          subscriptionStatus: "none",
          onboardingStep: 5,
          onboardingCompletedAt: null,
        }),
      ),
    ).toBe("/onboarding");
  });

  it("sends them to /subscribe once parked on the pricing step", () => {
    expect(
      onboardingRedirectPath(
        user({
          cardRequiredAtSignup: true,
          cardConfirmedAt: null,
          subscriptionStatus: "none",
          onboardingStep: ONBOARDING_PRICING_STEP,
          onboardingCompletedAt: null,
        }),
      ),
    ).toBe("/subscribe");
  });

  it("keeps walling on every subsequent login — the decision is stateless", () => {
    const u = user({
      cardRequiredAtSignup: true,
      cardConfirmedAt: null,
      subscriptionStatus: "none",
      onboardingStep: 0,
      onboardingCompletedAt: DONE,
    });
    expect(onboardingRedirectPath(u)).toBe("/subscribe");
    expect(onboardingRedirectPath(u)).toBe("/subscribe");
  });

  it("opens the dashboard once the card lands", () => {
    expect(
      onboardingRedirectPath(
        user({
          cardRequiredAtSignup: true,
          cardConfirmedAt: "2026-01-01T00:00:00.000Z",
          subscriptionStatus: "trialing",
          onboardingStep: 0,
          onboardingCompletedAt: DONE,
        }),
      ),
    ).toBe("/dashboard");
  });
});

describe("onboardingRedirectPath — grandfathered and unrelated users", () => {
  it("still sends a card-less 'none' user to the dashboard", () => {
    expect(
      onboardingRedirectPath(
        user({
          cardRequiredAtSignup: false,
          subscriptionStatus: "none",
          onboardingStep: 0,
          onboardingCompletedAt: DONE,
        }),
      ),
    ).toBe("/dashboard");
  });

  it("treats a profile cached before the column shipped as grandfathered", () => {
    expect(
      onboardingRedirectPath(
        user({ subscriptionStatus: "none", onboardingStep: 0, onboardingCompletedAt: DONE }),
      ),
    ).toBe("/dashboard");
  });

  it("still resumes a mid-funnel card-less user in the guided flow", () => {
    expect(
      onboardingRedirectPath(
        user({ subscriptionStatus: "none", onboardingStep: 6, onboardingCompletedAt: null }),
      ),
    ).toBe("/onboarding");
  });

  it("never card-walls STAFF — they have no customer profile to satisfy it with", () => {
    expect(onboardingRedirectPath(user(null, "STAFF"))).toBe(STAFF_NO_ACCESS_PATH);
  });

  it("handles a null user / missing profile", () => {
    expect(onboardingRedirectPath(null)).toBe("/dashboard");
    expect(onboardingRedirectPath(user(null))).toBe("/dashboard");
  });
});
