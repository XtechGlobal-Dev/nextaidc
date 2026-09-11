import { describe, it, expect } from "vitest";
import { cardWallActive } from "./cardWall";
import type { AuthUser } from "@/lib/api";
import type { Profile } from "@/types";

/* The client half of the card wall. `subscriptionStatus: "none"` means two
 * different things depending on the account's own signup snapshot, and getting
 * the default wrong in either direction is severe: too strict locks out every
 * existing customer, too loose makes the wall decorative. */

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

describe("cardWallActive", () => {
  it("walls a card-required account that never confirmed a card", () => {
    expect(
      cardWallActive(
        user({ cardRequiredAtSignup: true, cardConfirmedAt: null, subscriptionStatus: "none" }),
      ),
    ).toBe(true);
  });

  it("GRANDFATHERING: does not wall a card-less account on the same 'none' status", () => {
    expect(cardWallActive(user({ cardRequiredAtSignup: false, subscriptionStatus: "none" }))).toBe(
      false,
    );
  });

  it("treats a profile cached before the columns shipped as grandfathered", () => {
    // useAuthStore rehydrates from localStorage and marks the session authed
    // BEFORE /me returns, so an old cached profile renders at least once. If
    // undefined read as "wall them", every existing user would be bounced to
    // /subscribe on their next page load.
    expect(cardWallActive(user({ subscriptionStatus: "none" }))).toBe(false);
  });

  it("stops walling once the card is confirmed", () => {
    expect(
      cardWallActive(
        user({
          cardRequiredAtSignup: true,
          cardConfirmedAt: "2026-01-01T00:00:00.000Z",
          subscriptionStatus: "trialing",
        }),
      ),
    ).toBe(false);
  });

  // The bypass an adversarial review found: /subscribe opens a real Stripe trial
  // subscription before any card exists, so Stripe reports "trialing" and the
  // billing webhook mirrors it onto the profile. /billing/renew's failure path
  // writes "past_due", and an abandoned trial is cancelled to "canceled". A
  // status-keyed wall would drop for a user who never entered a card.
  it.each(["trialing", "active", "past_due", "canceled"])(
    "keeps walling when the status is %s but no card was ever confirmed",
    (status) => {
      expect(
        cardWallActive(
          user({ cardRequiredAtSignup: true, cardConfirmedAt: null, subscriptionStatus: status }),
        ),
      ).toBe(true);
    },
  );

  it("walls when cardConfirmedAt is absent entirely, not just null", () => {
    expect(cardWallActive(user({ cardRequiredAtSignup: true }))).toBe(true);
  });

  it.each(["ADMIN", "STAFF", "RESELLER"] as const)("never walls %s", (role) => {
    expect(
      cardWallActive(
        user({ cardRequiredAtSignup: true, cardConfirmedAt: null, subscriptionStatus: "none" }, role),
      ),
    ).toBe(false);
  });

  it("handles a null user / null profile without throwing", () => {
    expect(cardWallActive(null)).toBe(false);
    expect(cardWallActive(undefined)).toBe(false);
    expect(cardWallActive(user(null))).toBe(false);
  });
});
