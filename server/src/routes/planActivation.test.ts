import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// /confirm-card decides whether a card is stored or billed and whether the plan goes
// live. Source-pinned rather than mocked; each test maps to a reported billing bug.

const src = readFileSync(
  resolve(import.meta.dirname, "billing.routes.ts"),
  "utf8",
);
const stripeSrc = readFileSync(
  resolve(import.meta.dirname, "../services/stripe.ts"),
  "utf8",
);

/** The body of the /confirm-card handler. */
const confirmCard = (() => {
  const start = src.indexOf('"/confirm-card"');
  expect(start, "/confirm-card route not found").toBeGreaterThan(-1);
  // Up to the next route registration.
  const end = src.indexOf("router.post(", start + 10);
  return src.slice(start, end === -1 ? undefined : end);
})();

describe("buying a plan charges and activates it", () => {
  it("accepts an explicit activateNow purchase flag", () => {
    expect(confirmCard).toMatch(/activateNow: z\.boolean\(\)\.optional\(\)/);
  });

  it("charges when activateNow is set, not only when the trial is spent", () => {
    // The old condition was `if (ent.blocked)` alone, which is why buying a plan
    // mid-trial silently started a trial instead of billing.
    expect(confirmCard).toMatch(
      /if \(activateNow \|\| \(ent\.blocked && !firstCardForCardRequired\)\)/,
    );
  });

  it("does NOT charge a card-required signup's first card — the free trial still runs", () => {
    // A card-required account is `blocked` until a card lands — that means "no card",
    // not "trial spent". Reading it as the latter billed full price on day one.
    expect(confirmCard).toMatch(
      /const firstCardForCardRequired =\s*\n?\s*profile\.cardRequiredAtSignup && !profile\.cardConfirmedAt;/,
    );
  });

  it("decides 'first card' from cardConfirmedAt, not the subscription status", () => {
    // Stripe cancels an abandoned card-required signup's unpaid sub, so the profile
    // reads "canceled"; keying on "none" would charge that returning user full price.
    expect(confirmCard).not.toMatch(/cardRequiredAtSignup && profile\.subscriptionStatus === "none"/);
  });

  it("always enters the activation block for a first card, whatever the status says", () => {
    // Only writer of cardConfirmedAt (the card wall's signal). A walled account can be
    // "trialing" with no card, so a status gate would leave it null and wall them forever.
    expect(confirmCard).toMatch(
      /if \(\s*\n?\s*activateNow \|\|\s*\n?\s*firstCardForCardRequired \|\|/,
    );
    // …and the flag must be derived ABOVE that gate, not inside it.
    expect(confirmCard.indexOf("const firstCardForCardRequired")).toBeLessThan(
      confirmCard.indexOf("activateNow ||"),
    );
  });

  it("records the card so the wall can never be lifted by an upstream Stripe event", () => {
    // cardConfirmedAt is the wall's signal precisely because this route is its
    // only writer — both the charge branch and the trial branch must stamp it.
    const stamps = confirmCard.match(
      /\.\.\.\(profile\.cardConfirmedAt \? \{\} : \{ cardConfirmedAt: new Date\(\) \}\)/g,
    );
    expect(stamps, "both /confirm-card branches must stamp cardConfirmedAt").toHaveLength(2);
  });

  it("starts the trial clock for that first card instead of leaving it unset", () => {
    // Snapshot the allowance now, or a later admin change to trial minutes shrinks a running trial.
    expect(confirmCard).toMatch(/firstCardForCardRequired \? await buildTrialStartData\(\) : null/);
    // Usage is never reset here: a grandfathered user must not be handed minutes.
    expect(confirmCard).not.toMatch(/trialSecondsUsed:/);
  });
});

// Other places write subscriptionStatus, so a card wall keyed on that string can be
// lifted without a card ever being entered.
describe("nothing but /confirm-card can lift the card wall", () => {
  it("the Stripe webhook does not promote an account awaiting its first card", () => {
    const start = src.indexOf('"customer.subscription.');
    expect(start, "subscription webhook branch not found").toBeGreaterThan(-1);
    const branch = src.slice(start - 2000, start + 4000);
    expect(branch).toMatch(
      /const awaitingFirstCard = profile\.cardRequiredAtSignup && !profile\.cardConfirmedAt;/,
    );
    // Stripe reports the /subscribe trial subscription as "trialing" before any
    // card exists; mirroring that verbatim handed out the whole free trial.
    expect(branch).toMatch(/awaitingFirstCard && rawStatus !== "canceled"/);
  });

  it("/billing/renew refuses an account that has never confirmed a card", () => {
    const start = src.indexOf('"/renew"');
    expect(start, "/renew route not found").toBeGreaterThan(-1);
    const handler = src.slice(start, src.indexOf("router.post(", start + 10));
    expect(handler).toMatch(/profile\.cardRequiredAtSignup && !profile\.cardConfirmedAt/);
    // endTrialNow with no payment method threw and the catch wrote "past_due", moving the
    // account off the walled status — so the guard must sit above the Stripe work.
    expect(handler.indexOf("!profile.cardConfirmedAt")).toBeLessThan(
      handler.indexOf("await endTrialNow("),
    );
  });

  it("runs the charge even when the profile is already trialing", () => {
    // The handler used to skip the whole block for a "trialing" profile, so `activateNow`
    // must be its own disjunct ahead of the status test.
    expect(confirmCard).toMatch(
      /activateNow \|\|[\s\S]{0,200}?\(profile\.subscriptionStatus !== "trialing"/,
    );
  });

  it("bills the card the user just entered", () => {
    expect(confirmCard).toMatch(/setSubscriptionDefaultPaymentMethod\(\s*profile\.stripeSubscriptionId,\s*paymentMethodId/);
  });
});

describe("a declined card leaves the user able to retry", () => {
  it("ends the trial atomically so a decline rolls back", () => {
    expect(confirmCard).toMatch(/endTrialNow\(profile\.stripeSubscriptionId, \{ errorIfIncomplete: true \}\)/);
  });

  it("does not strand the user in past_due on the purchase path", () => {
    // Writing "past_due" on failure pushed the retry down the "create" path and
    // duplicated the sub. Only an actual write matters, not a mention in a comment.
    expect(confirmCard).not.toMatch(/subscriptionStatus:\s*"past_due"/);
  });

  it("says plainly that the plan is NOT active", () => {
    expect(confirmCard).toMatch(/declined, so your plan isn't active yet/);
  });

  it("cancels the replaced subscription so a retry can't leave two live", () => {
    expect(src).toMatch(
      /if \(previousSubscriptionId && previousSubscriptionId !== subscriptionId\) \{[\s\S]*?cancelSubscription\(previousSubscriptionId\)/,
    );
  });
});

describe("setSubscriptionDefaultPaymentMethod", () => {
  it("forces the given card rather than keeping an existing default", () => {
    const fn = stripeSrc.slice(stripeSrc.indexOf("export async function setSubscriptionDefaultPaymentMethod"));
    expect(fn).toMatch(/default_payment_method: paymentMethodId/);
    // ensureSubscriptionDefaultPaymentMethod bails out when a default exists —
    // this one must not, or a retry re-bills the refused card.
    expect(fn.slice(0, fn.indexOf("\n}"))).not.toMatch(/if \(sub\.default_payment_method\) return/);
  });
});
