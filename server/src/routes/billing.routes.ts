import express from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { tenantForUser, requestTenant, currentTenant } from "../services/tenantDb.js";
import { withPlan } from "../services/planLookup.js";
import { asyncHandler, badRequest, notFound, notImplemented } from "../lib/http.js";
import { formatDateDMY } from "../lib/date.js";
import { transferDepartmentAllowance } from "../lib/transfer.js";
import { requireAuth } from "../middleware/auth.js";
import {
  constructEvent,
  createTrialSubscription,
  stripe,
  isStripeConfigured,
  stripeWebhookSecret,
  getCardFingerprint,
  attachPaymentMethod,
  cancelSubscription,
  getCustomerInvoices,
  swapSubscriptionPriceNow,
  switchTrialSubscriptionPlan,
  scheduleDowngrade,
  releaseSchedule,
  chargeOneTime,
  setSubscriptionAutoRenew,
  renewSubscriptionNow,
  createImmediateSubscription,
  createCurrencySwitchSubscription,
  endTrialNow,
  getSubscription,
  getLatestPaidInvoice,
  setSubscriptionDefaultPaymentMethod,
  attachSubscriptionDiscount,
  detachSubscriptionDiscount,
} from "../services/stripe.js";
import { getTrialDays, getTrialMinutes } from "../services/billing.js";
import { rateLimit } from "../middleware/rateLimit.js";
import {
  activateRedemption,
  clearOtherPendingReservations,
  consumeCycle,
  effectiveIncludedMinutes,
  getActiveRedemption,
  rejectionMessage,
  reserveRedemption,
  validateCoupon,
} from "../services/coupons.js";
import { provisionAgentForUser, syncAssistantCallCap } from "../services/provisioning.js";
import {
  applyActivePlanMinutes,
  notifyPlanActivated,
  getEntitlement,
  computeProration,
  reconcileSubscription,
  buildTrialStartData,
} from "../services/trial.js";
import { accrueCommissionForInvoice } from "../services/commission.js";
import { recordPlanEvent } from "../services/planHistory.js";
import { brandAppUrl } from "../lib/brandUrls.js";
import { brandPlanIds } from "../services/brandSetup.js";
import {
  brandAddonOnPrice,
  brandAddonsFor,
  customerPlanPriceCents,
  livePriceId,
  stripePriceIdFor,
} from "../services/brandPricing.js";
import { reverseCreditForRefund } from "../services/brandWallet.js";
import { recordPaidInvoice, recordRefund } from "../services/platformLedger.js";
import { indexStripeCustomer, resolveStripeCustomer } from "../services/stripeCustomers.js";
import { customerIdOf, isRoutedEventType, parkUnroutedEvent } from "../services/stripeUnrouted.js";
import { runWithBrand } from "../lib/brandContext.js";
import { brandIdForOwner } from "../services/customerDirectory.js";
import type Stripe from "stripe";

const router = express.Router();

/** Public: active plans for the signup picker. */
router.get(
  "/plans",
  asyncHandler(async (req, res) => {
    // A white-label brand sells the plans it chose; an empty list means all of
    // them. The brand is the request's front door (host / Origin / X-Brand),
    // which is the one whose subscribe page is asking.
    const allowed = brandPlanIds(req.brand);
    const plans = await prisma.subscriptionPlan.findMany({
      where: { active: true, ...(allowed.length ? { id: { in: allowed } } : {}) },
      // sortOrder first; ties broken by price, then creation time — so plans with
      // the same sort order always appear in a stable order on the subscribe page.
      orderBy: [{ sortOrder: "asc" }, { priceCents: "asc" }, { createdAt: "asc" }],
    });
    // Resolve voice-category names so the subscribe page can show a voice pill
    // ("Basic"/"Premium") like the admin card — plans carry only the id, and the
    // category endpoint itself is admin-only.
    const catIds = [...new Set(plans.map((p) => p.voiceCategoryId).filter((id): id is string => !!id))];
    const cats = catIds.length
      ? await prisma.voiceCategory.findMany({ where: { id: { in: catIds } }, select: { id: true, title: true } })
      : [];
    const nameById = new Map(cats.map((c) => [c.id, c.title]));
    // A brand's customers see the brand's price — base plus its addon — AS the
    // plan's price. The base rides alongside for anything that wants to say so.
    const addons = await brandAddonsFor(req.brand?.id, plans.map((p) => p.id));
    res.json(
      plans.map((p) => {
        const addonCents = addons.get(p.id) ?? 0;
        return {
          ...p,
          priceCents: p.priceCents + addonCents,
          basePriceCents: p.priceCents,
          addonCents,
          voiceCategoryName: p.voiceCategoryId ? (nameById.get(p.voiceCategoryId) ?? null) : null,
        };
      }),
    );
  }),
);

/** Public: the global free-trial terms, so the subscribe page can spell out
 *  exactly what the card-on-file trial gives before the user commits. */
router.get(
  "/trial-info",
  asyncHandler(async (_req, res) => {
    const [days, minutes] = await Promise.all([getTrialDays(), getTrialMinutes()]);
    res.json({ days, minutes });
  }),
);

/**
 * Check a coupon code against a plan for the signed-in user, without reserving
 * anything — so the checkout page can validate as the user types and show the
 * discounted total live.
 *
 * Rate-limited and deliberately vague on failure (see `rejectionMessage`): a
 * precise "no such code" would turn this into a code-enumeration oracle.
 */
router.post(
  "/coupon/validate",
  requireAuth,
  rateLimit({ windowMs: 60_000, max: 20, message: "Too many code attempts. Please wait a minute." }),
  asyncHandler(async (req, res) => {
    const { code, planId } = z
      .object({ code: z.string().min(1).max(40), planId: z.string().min(1) })
      .parse(req.body);

    const plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId } });
    if (!plan) throw badRequest("Plan not found");

    const result = await validateCoupon({ code, planId, userId: req.user!.sub });
    if (!result.ok) {
      res.json({ valid: false, message: rejectionMessage(result.reason) });
      return;
    }

    const { coupon } = result;
    const discountCents = coupon.percentOff
      ? Math.round((plan.priceCents * coupon.percentOff) / 100)
      : 0;
    res.json({
      valid: true,
      code: coupon.code,
      displayName: coupon.displayName,
      description: coupon.description,
      percentOff: coupon.percentOff,
      bonusMinutes: coupon.bonusMinutes,
      durationCycles: coupon.durationCycles,
      discountCents,
      newTotalCents: Math.max(0, plan.priceCents - discountCents),
      currency: plan.currency,
    });
  }),
);

/**
 * Start a trial subscription for the signed-in user on the chosen plan.
 * Returns a SetupIntent client secret the frontend confirms with Elements
 * (saves the card). Trial auto-charges when it ends.
 */
router.post(
  "/subscribe",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!isStripeConfigured()) throw notImplemented("Stripe is not configured");
    const { planId, autoRenew, couponCode } = z
      .object({
        planId: z.string().min(1),
        autoRenew: z.boolean().optional(),
        couponCode: z.string().max(40).optional(),
      })
      .parse(req.body);
    const userId = req.user!.sub;

    const plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId } });
    if (!plan || !plan.active) throw badRequest("Plan not found or inactive");
    if (!plan.stripePriceId) throw badRequest("This plan isn't linked to Stripe yet");
    // The brand's own Price when this customer's brand adds a charge on top.
    const priceId = (await stripePriceIdFor(plan, req.user!.brandId)) ?? plan.stripePriceId;

    // Re-validate the code server-side. If it no longer applies (the last slot
    // went to someone else, or the user re-picked a plan the code doesn't
    // cover), FAIL rather than quietly continuing at full price — nobody should
    // reach the card step believing a discount is applied when it isn't.
    let coupon = null;
    if (couponCode?.trim()) {
      const result = await validateCoupon({ code: couponCode, planId, userId });
      if (!result.ok) throw badRequest(rejectionMessage(result.reason));
      coupon = result.coupon;
    }

    // Drop any reservation held for a DIFFERENT code (the user changed their
    // mind mid-signup), so an abandoned choice doesn't sit on a supply slot
    // until the sweep and doesn't collide with the new one.
    await clearOtherPendingReservations(userId, coupon?.id ?? null);

    const profile = await (await requestTenant(req)).profile.findUnique({ where: { userId } });
    const trialDays = await getTrialDays();
    const previousCustomerId = profile?.stripeCustomerId ?? null;
    const previousSubscriptionId = profile?.stripeSubscriptionId ?? null;

    // Already in a trial (e.g. re-picking a plan during signup)? Reuse the
    // existing trial subscription and just swap which plan it's on — do NOT open
    // a second Stripe subscription. Opening another would orphan the first (it
    // stays live and could double-charge at trial end) and log a duplicate
    // "trial started". A genuine plan change logs `plan_switched` instead.
    // Only safe when the currency matches; a currency switch still needs a fresh
    // customer, so those fall through to the create path (which cancels the old).
    if (profile?.subscriptionStatus === "trialing" && previousSubscriptionId && profile.subscriptionPlanId) {
      const current = await prisma.subscriptionPlan.findUnique({
        where: { id: profile.subscriptionPlanId },
      });
      if (current && current.currency === plan.currency) {
        const { clientSecret, trialEnd } = await switchTrialSubscriptionPlan(
          previousSubscriptionId,
          priceId,
        );

        // Keep the subscription's discount in step with the code the user is
        // holding right now: attach the (re-validated) one, or clear it if they
        // removed the code or swapped to a plan it doesn't cover.
        try {
          if (coupon?.stripeCouponId) {
            await attachSubscriptionDiscount(previousSubscriptionId, coupon.stripeCouponId);
          } else {
            await detachSubscriptionDiscount(previousSubscriptionId);
          }
        } catch {
          /* best-effort — /confirm-card only activates a redemption we reserved */
        }
        if (coupon) await reserveRedemption(coupon.id, userId);

        const renew = autoRenew ?? true;
        if (!renew) {
          try {
            await setSubscriptionAutoRenew(previousSubscriptionId, false);
          } catch {
            /* best-effort — the user can still toggle it from the Plans page */
          }
        }

        await (await requestTenant(req)).profile.update({
          where: { userId },
          data: {
            subscriptionPlanId: plan.id,
            subscriptionStatus: "trialing",
            autoRenew: renew,
            // Keep the ORIGINAL trial clock — a plan swap must not restart it.
            trialEndsAt: trialEnd ? new Date(trialEnd * 1000) : profile.trialEndsAt,
            scheduledPlanId: null,
            scheduledPlanEffectiveAt: null,
          },
        });

        void provisionAgentForUser(userId).catch(() => {});

        // Re-picking the SAME plan is a no-op we don't spam the timeline with;
        // only a real change earns a history entry.
        if (current.id !== plan.id) {
          void recordPlanEvent({
            userId,
            type: "plan_switched",
            fromPlanId: current.id,
            fromPlanName: current.displayName,
            toPlanId: plan.id,
            toPlanName: plan.displayName,
            priceCents: plan.priceCents,
            currency: plan.currency,
            note: "Trial plan switched before checkout (no charge)",
          });
        }

        res.json({ clientSecret, subscriptionId: previousSubscriptionId });
        return;
      }
    }

    // The trial subscription is plan-only — every feature is bundled into the plan.
    // Pass the plan currency so a customer locked to a different currency (e.g. an
    // old USD customer subscribing to a new AUD plan) is moved to a fresh customer
    // instead of failing with Stripe's "cannot combine currencies" error.
    const { customerId, subscriptionId, clientSecret, trialEnd } = await createTrialSubscription({
      email: req.user!.email,
      owner: { brandId: req.user!.brandId, userId },
      priceIds: [priceId],
      trialDays,
      existingCustomerId: previousCustomerId,
      currency: plan.currency,
      // Attached at CREATION, not afterwards: the checkout charge bills this
      // subscription's first invoice, so a discount added later would miss it.
      couponId: coupon?.stripeCouponId ?? null,
    });
    // Hold the supply slot. It doesn't count yet — only /confirm-card, once the
    // card is actually charged, promotes it to a real redemption.
    if (coupon) await reserveRedemption(coupon.id, userId);

    // Cancel whatever subscription we just replaced. Two cases reach here:
    //  • a currency switch forced a new Stripe customer, so the old subscription
    //    would be left dangling on the old currency;
    //  • the previous attempt is unusable (past_due / canceled / incomplete) and
    //    the user is retrying — the reuse branch above only covers "trialing".
    // Without this a retry left the failed subscription live alongside the new
    // one, so the customer had two and could be billed twice.
    if (previousSubscriptionId && previousSubscriptionId !== subscriptionId) {
      await cancelSubscription(previousSubscriptionId).catch(() => {
        /* best-effort — never block a paying customer on tidy-up */
      });
    }

    const renew = autoRenew ?? true;
    // Off → end the trial/plan at period end with no charge (Stripe handles it).
    if (!renew) {
      try {
        await setSubscriptionAutoRenew(subscriptionId, false);
      } catch {
        /* best-effort — the user can still toggle it from the Plans page */
      }
    }

    // Persist the PENDING trial subscription, but DON'T activate the trial yet —
    // no subscriptionStatus flip, no minute grant, no provisioning. The trial is
    // activated in /confirm-card, once a real card is on file. This is the gate
    // that stops "free-trial farming": picking a plan on /subscribe and leaving
    // without a card (or re-picking plans) can no longer grant fresh trial minutes.
    await (await requestTenant(req)).profile.update({
      where: { userId },
      data: {
        subscriptionPlanId: plan.id,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        autoRenew: renew,
        trialEndsAt: trialEnd ? new Date(trialEnd * 1000) : null,
      },
    });
    // How this customer's payments find their brand from now on.
    await indexStripeCustomer(customerId, { brandId: req.user!.brandId, userId });

    res.json({ clientSecret, subscriptionId });
  }),
);

/**
 * Confirm the just-saved card AND activate the trial. The frontend calls this
 * right after Stripe's SetupIntent succeeds, passing the payment method id.
 *
 * This is where the trial actually starts (subscriptionStatus → "trialing", trial
 * minutes granted) — NOT at /subscribe — so a plan chosen without a card never
 * grants trial minutes. Card uniqueness is NOT enforced (the same card may fund
 * multiple accounts; sign-up is gated by a unique mobile number instead).
 */
router.post(
  "/confirm-card",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!isStripeConfigured()) throw notImplemented("Stripe is not configured");
    const { paymentMethodId, activateNow } = z
      .object({
        paymentMethodId: z.string().min(1),
        /** Sent by the explicit "choose a plan and pay" flow. Charges the card and
         *  activates the plan straight away instead of continuing the free trial:
         *  someone who deliberately bought a plan expects to be on it, not to be
         *  told their trial started. Absent (the trial-start flow) keeps the old
         *  no-charge behaviour, so nobody is billed for saving a card. */
        activateNow: z.boolean().optional(),
      })
      .parse(req.body);
    const userId = req.user!.sub;

    const profile = await (await requestTenant(req)).profile.findUnique({ where: { userId } });
    if (!profile?.stripeCustomerId) throw badRequest("Start a subscription first");

    // The payment method must belong to this user's own Stripe customer.
    const { customerId } = await getCardFingerprint(paymentMethodId);
    if (customerId && customerId !== profile.stripeCustomerId) {
      throw badRequest("This payment method doesn't belong to your account");
    }
    // An UNATTACHED method (customerId null) used to slip through the check above,
    // because it matches nobody. That is not a formality any more: this handler
    // stamps cardConfirmedAt, which is what the onboarding card wall keys on — so
    // a caller who minted a PaymentMethod with the publishable key and posted it
    // straight here would lift their own wall with no card on file anywhere.
    // The SetupIntent normally attaches it on success; do it ourselves when it
    // hasn't, so "card on file" is a fact rather than a claim, and fail closed if
    // Stripe won't take it.
    if (!customerId) {
      try {
        await attachPaymentMethod(paymentMethodId, profile.stripeCustomerId);
      } catch {
        throw badRequest("We couldn't save that card. Please try again or use another card.");
      }
    }

    // Activate the plan now that a real card is confirmed — the ONLY place it's
    // ever activated (never at /subscribe), so a plan chosen without a card grants
    // nothing. Skip when already on a live trial/plan (a plan switch / double-submit).
    // `charged` = we billed the card now (trial was used up) vs started/continued a
    // trial — the client uses it to show the right success toast.
    let charged = false;
    // A card-required signup is `blocked` BY DESIGN until a card lands — that
    // block means "no card yet", NOT "free trial spent". This is their first
    // card and their trial hasn't started, so it must take the trial branch:
    // treating them as blocked would bill the full plan price on day one, the
    // opposite of the $0-auth-plus-free-trial policy they signed up under.
    //
    // Keyed on cardConfirmedAt rather than subscriptionStatus === "none": an
    // abandoned card-required signup has its unpaid trial subscription cancelled
    // by Stripe (missing_payment_method: "cancel"), landing the profile on
    // "canceled". Keying on the status would then charge that returning user the
    // full plan price for a trial they never actually received.
    const firstCardForCardRequired = profile.cardRequiredAtSignup && !profile.cardConfirmedAt;
    // `activateNow` is an explicit purchase, so it must go through even when the
    // profile is already "trialing" — that is exactly the case the user hits when
    // they buy a plan part-way through their trial.
    //
    // `firstCardForCardRequired` must ALSO force entry, whatever the status says.
    // This block is the only writer of cardConfirmedAt, and cardConfirmedAt is the
    // card wall's signal — so skipping it would accept the customer's card, leave
    // the flag null, and bounce them to /subscribe on this and every future login
    // while Stripe happily charges them at trial end. A walled account can reach
    // "trialing" without a card (admin suspend → reactivate restores it from
    // trialEndsAt, which /subscribe sets before any card exists), so the status
    // alone cannot be trusted to let the first card through.
    if (
      activateNow ||
      firstCardForCardRequired ||
      (profile.subscriptionStatus !== "trialing" && profile.subscriptionStatus !== "active")
    ) {
      // The user gets exactly ONE trial — the free minutes granted at signup.
      const ent = await getEntitlement(userId);
      const plan = profile.subscriptionPlanId
        ? await prisma.subscriptionPlan.findUnique({ where: { id: profile.subscriptionPlanId } })
        : null;

      // Charge when they asked to buy, or when the free trial is spent (no second
      // trial). Otherwise the trial simply continues with a card on file.
      if (activateNow || (ent.blocked && !firstCardForCardRequired)) {
        charged = true;
        // End the Stripe trial now, which bills the saved card, then activate the
        // paid plan. Either they bought deliberately, or the free trial is spent
        // and there is no second one.
        if (!profile.stripeSubscriptionId) throw badRequest("No subscription to activate");
        // Bill the card the user just entered, not whatever default the customer
        // happened to have. On a retry after a decline that default IS the refused
        // card, so without this the second attempt fails identically.
        try {
          await setSubscriptionDefaultPaymentMethod(profile.stripeSubscriptionId, paymentMethodId);
        } catch {
          /* best-effort — a single-card customer is already pointing at the right one */
        }
        // errorIfIncomplete makes this atomic: a decline throws AND leaves the
        // subscription trialing, so the user stays exactly where they were and can
        // try another card. Dropping them to past_due instead used to leave them
        // stranded — the retry then took the "create" path and opened a SECOND
        // Stripe subscription alongside the failed one.
        try {
          await endTrialNow(profile.stripeSubscriptionId, { errorIfIncomplete: true });
        } catch {
          throw badRequest(
            "Your card was declined, so your plan isn't active yet. Try another card.",
          );
        }
        const sub = await getSubscription(profile.stripeSubscriptionId).catch(() => null);
        if (!sub || sub.status !== "active") {
          throw badRequest(
            "Your card was declined, so your plan isn't active yet. Try another card.",
          );
        }
        const periodEnd = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd * 1000) : null;
        await (await requestTenant(req)).profile.update({
          where: { userId },
          data: {
            subscriptionStatus: "active",
            trialEndsAt: null,
            currentPeriodEnd: periodEnd,
            // A card is now genuinely on file — this route is the only writer of
            // that fact, and it's what the card wall keys on. Recorded once (the
            // FIRST card), so a later card change doesn't move the timestamp.
            ...(profile.cardConfirmedAt ? {} : { cardConfirmedAt: new Date() }),
          },
        });
        // The card was charged, so a held coupon is now genuinely redeemed. Must
        // run BEFORE the minute grant so any bonus minutes are already live when
        // `effectiveIncludedMinutes` computes the allowance.
        await activateRedemption(userId, profile.stripeSubscriptionId);
        await applyActivePlanMinutes(userId, {
          includedMinutes: await effectiveIncludedMinutes(userId, plan?.includedMinutes ?? 0),
          periodEnd,
          resetUsage: true,
        });
        // This charge IS the coupon's first covered cycle — count it now that its
        // discount and bonus minutes have both landed. A single-cycle coupon
        // retires right here, so the next renewal is full price. Keyed on the
        // invoice this charge produced, so a later same-day renewal is recognised
        // as a separate cycle rather than a repeat of this one.
        const firstCycleInvoice = await getLatestPaidInvoice(profile.stripeSubscriptionId);
        await consumeCycle(
          userId,
          profile.stripeSubscriptionId,
          periodEnd,
          firstCycleInvoice?.id ?? null,
        );
        void recordPlanEvent({
          userId,
          type: "trial_converted",
          toPlanId: plan?.id,
          toPlanName: plan?.displayName,
          note: activateNow
            ? "Bought a plan outright — charged immediately and plan activated"
            : "Trial already used up — charged immediately and plan activated",
        });
      } else {
        // Free trial still has minutes → continue the SAME trial with a card on
        // file (no fresh minutes — usage carries over); converts to paid at end.
        //
        // For a card-required signup this is where the trial genuinely BEGINS —
        // they had no entitlement at all until this card landed — so snapshot the
        // allowance now, for the same reason trialMinutesAllocated exists at all:
        // an admin lowering the global trial minutes later must not shrink a trial
        // that is already running. trialSecondsUsed is deliberately NOT written:
        // a walled user has no usage to reset, and a grandfathered user must never
        // be handed a fresh allowance here.
        const trialStart = firstCardForCardRequired ? await buildTrialStartData() : null;
        await (await requestTenant(req)).profile.update({
          where: { userId },
          data: {
            subscriptionStatus: "trialing",
            // See the charge branch above — the card wall keys on this, not on the
            // status, because Stripe's webhook writes the status out of band.
            ...(profile.cardConfirmedAt ? {} : { cardConfirmedAt: new Date() }),
            ...(trialStart
              ? {
                  trialStartedAt: trialStart.trialStartedAt,
                  trialMinutesAllocated: trialStart.trialMinutesAllocated,
                  trialStatus: trialStart.trialStatus,
                  usageAlertsSent: trialStart.usageAlertsSent,
                }
              : {}),
          },
        });
        // Activate a held coupon here too, even though nothing was charged yet.
        // The discount is already attached to the subscription and WILL apply at
        // trial conversion — if we left the redemption pending, the sweep would
        // bin it and a multi-cycle discount would then run with nothing counting
        // its cycles, i.e. forever. `cyclesUsed` stays 0 until a real charge.
        await activateRedemption(userId, profile.stripeSubscriptionId);
        void recordPlanEvent({
          userId,
          type: "trial_started",
          toPlanId: plan?.id,
          toPlanName: plan?.displayName,
          note: "Trial continued with card (no reset)",
        });
      }
      void provisionAgentForUser(userId).catch(() => {});
    }

    res.json({ ok: true, charged });
  }),
);

/**
 * Apply one Stripe event to the account it concerns.
 *
 * Called by the webhook once the event has been placed in its brand (and the
 * brand's context set, so anything it sends is in the brand's name), and by
 * the super admin's retry of a parked event. Never throws for a business
 * reason: a webhook that fails is retried by Stripe forever, so anything that
 * cannot be applied is left for the next event or the reconcile sweep.
 */
export async function processStripeEvent(event: Stripe.Event): Promise<void> {
  if (event.type.startsWith("customer.subscription.")) {
    // Subscription lifecycle: keep the customer's status in sync.
    const sub = event.data.object as {
      id: string;
      customer: string;
      status: string;
      trial_end: number | null;
      current_period_end: number | null;
      cancel_at_period_end: boolean;
    };
    const profile = await withPlan(await (await currentTenant()).profile.findFirst({
      where: { OR: [{ stripeSubscriptionId: sub.id }, { stripeCustomerId: sub.customer }] } }));
    // A profile is matched on subscription id OR customer id, so an event for
    // a subscription the account has MOVED ON FROM still finds it. That is
    // exactly what a currency switch produces: the old subscription is
    // cancelled once the profile already points at the new one, and Stripe's
    // deleted event for it would otherwise mark a live, just-paid account
    // "canceled". Only the subscription the profile actually holds may
    // report its own death.
    if (
      profile &&
      event.type === "customer.subscription.deleted" &&
      profile.stripeSubscriptionId &&
      sub.id !== profile.stripeSubscriptionId
    ) {
      return;
    }
    if (profile) {
      const rawStatus = event.type === "customer.subscription.deleted" ? "canceled" : sub.status;
      // A card-required account that hasn't confirmed a card yet still OWNS a
      // live Stripe trial subscription: /subscribe creates it (that's where the
      // SetupIntent comes from) and deliberately leaves the local status at
      // "none", because /confirm-card is meant to be the only thing that starts
      // the trial. Stripe reports that subscription as "trialing" and fires
      // customer.subscription.created immediately — mirroring it here would
      // mark the account premium and hand it the full free trial when the user
      // has done nothing but pick a plan and close the tab.
      // Entitlement is keyed on cardConfirmedAt so it holds regardless, but the
      // stored status must stay honest too: it drives the admin panels.
      const awaitingFirstCard = profile.cardRequiredAtSignup && !profile.cardConfirmedAt;
      const status =
        awaitingFirstCard && rawStatus !== "canceled" ? profile.subscriptionStatus : rawStatus;
      const entitled = status === "trialing" || status === "active";
      // Mirror Stripe's cancel flag back onto the local auto-renew mirror. The
      // in-app toggle sets both DB + Stripe, but a cancel done in the Stripe
      // hosted portal ("Manage billing") only touches Stripe — without this the
      // local `autoRenew` stays true and the minutes-exhausted early renewal
      // (renewActivePlanIfExhausted) would still charge a card the user cancelled.
      // A gone (deleted/canceled) subscription can never auto-renew.
      const autoRenew = entitled ? !sub.cancel_at_period_end : false;

      // A pending downgrade takes effect once the billing period rolls past its
      // effective date (the Stripe schedule has swapped the price). Promote the
      // scheduled plan to the current plan and bill its minutes for the new cycle.
      const newPeriodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;
      const downgradeApplied =
        !!profile.scheduledPlanId &&
        !!profile.scheduledPlanEffectiveAt &&
        !!newPeriodEnd &&
        newPeriodEnd.getTime() > profile.scheduledPlanEffectiveAt.getTime();

      let effectivePlanId = profile.subscriptionPlanId;
      // The PLAN's own minutes for this cycle. Any coupon bonus is added on
      // top by the `effectiveIncludedMinutes` service call at the grant.
      let effectivePlanMinutes = profile.subscriptionPlan?.includedMinutes ?? 0;
      if (downgradeApplied) {
        const scheduled = await prisma.subscriptionPlan.findUnique({
          where: { id: profile.scheduledPlanId! },
          select: { id: true, includedMinutes: true },
        });
        if (scheduled) {
          effectivePlanId = scheduled.id;
          effectivePlanMinutes = scheduled.includedMinutes;
        }
      }

      await (await currentTenant()).profile.update({
        where: { userId: profile.userId },
        data: {
          subscriptionStatus: status,
          stripeSubscriptionId: sub.id,
          autoRenew,
          trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
          // Mirror the coarse legacy flag so premium-gated features unlock during trial/active.
          plan: entitled ? "premium" : "free",
          ...(downgradeApplied
            ? {
                subscriptionPlanId: effectivePlanId,
                scheduledPlanId: null,
                scheduledPlanEffectiveAt: null,
                stripeScheduleId: null,
              }
            : {}),
        },
      });

      // History: a scheduled downgrade just took effect at the period boundary.
      if (downgradeApplied) {
        void recordPlanEvent({
          userId: profile.userId,
          type: "downgraded",
          fromPlanId: profile.subscriptionPlanId,
          toPlanId: effectivePlanId,
          note: "Scheduled downgrade took effect at period end",
        });
      }
      // History: the free trial converted into a paying subscription.
      if (status === "active" && profile.subscriptionStatus === "trialing") {
        void recordPlanEvent({
          userId: profile.userId,
          type: "trial_converted",
          toPlanId: effectivePlanId,
          note: "Free trial converted to a paid subscription",
        });
      }
      // History: the subscription is gone (Stripe cancel / trial lapsed without card).
      if (status === "canceled" && profile.subscriptionStatus !== "canceled") {
        void recordPlanEvent({
          userId: profile.userId,
          type: "canceled",
          fromPlanId: profile.subscriptionPlanId,
          note: "Subscription canceled",
        });
      }

      // When the subscription is active (trial converted, or a renewal),
      // grant/reset the plan's included call minutes for the new period.
      if (status === "active") {
        const wasActive = profile.subscriptionStatus === "active";
        // On a trial→active conversion, carry the trial OVERAGE (minutes used
        // past the trial allowance — e.g. a last call that ran on after
        // auto-renew) into the new paid cycle. It lives in the trial counter.
        const trialAllocSec = (profile.trialMinutesAllocated ?? 0) * 60;
        const trialOverageSec =
          profile.subscriptionStatus === "trialing" && trialAllocSec > 0
            ? Math.max(0, profile.trialSecondsUsed - trialAllocSec)
            : 0;
        await applyActivePlanMinutes(profile.userId, {
          includedMinutes: await effectiveIncludedMinutes(profile.userId, effectivePlanMinutes),
          periodEnd: newPeriodEnd,
          // Only a genuine transition INTO active (trial converted, or a
          // reactivation) grants a fresh allowance. This event also fires for
          // edits that change nothing about the cycle — an auto-renew toggle, a
          // downgrade being scheduled/released, a price swap — and those must
          // leave the usage counter alone. A real renewal still resets via the
          // period-end advance inside applyActivePlanMinutes.
          resetUsage: !wasActive,
          ...(trialOverageSec > 0 ? { carryOverSeconds: trialOverageSec } : {}),
        });
        // Count a coupon cycle for the charge this event reports. Keyed on the
        // latest PAID invoice: the events that fire without a real renewal (an
        // auto-renew toggle, a downgrade being scheduled, a price swap) carry
        // the invoice that was already counted and are ignored — as is the
        // webhook our own early renewal triggers. A genuine renewal brings a
        // new invoice, so it counts even when it lands the same day as the
        // last one, which the period end alone could not distinguish.
        const cycleInvoice = await getLatestPaidInvoice(sub.id).catch(() => null);
        await consumeCycle(profile.userId, sub.id, newPeriodEnd, cycleInvoice?.id ?? null);
        // Email/notify only on the trial→active transition, not on renewals.
        if (!wasActive) void notifyPlanActivated(profile.userId);
      }
      // Re-sync the live assistant's per-call cap to the new entitlement
      // (grows on trial→active, resets each renewal, shrinks when blocked).
      if (entitled) void syncAssistantCallCap(profile.userId).catch(() => {});
    }
  } else if (event.type === "invoice.payment_succeeded") {
    // A referred customer paid → accrue commission for their reseller.
    const invoice = event.data.object as {
      id: string;
      customer: string;
      amount_paid: number;
      currency?: string;
      billing_reason?: string | null;
      discount?: { coupon?: { id?: string } | null } | null;
      lines?: {
        data?: {
          price?: { id?: string } | null;
          pricing?: { price_details?: { price?: string } };
          period?: { start?: number; end?: number } | null;
        }[];
      };
    };
    await accrueCommissionForInvoice({
      invoiceId: invoice.id,
      customerId: invoice.customer,
      amountPaidCents: invoice.amount_paid,
    });
    // The payment goes in the platform ledger, split into the platform's
    // and the brand's share, and the brand's wallet is credited from that
    // row. The line's Price says whether this subscription is on the
    // brand's own Price at all (older and newer Stripe API shapes both
    // checked).
    const line = invoice.lines?.data?.[0];
    await recordPaidInvoice({
      invoiceId: invoice.id,
      customerId: invoice.customer,
      amountPaidCents: invoice.amount_paid,
      priceId: line?.price?.id ?? line?.pricing?.price_details?.price ?? null,
      currency: invoice.currency ?? null,
      periodStart: line?.period?.start ? new Date(line.period.start * 1000) : null,
      periodEnd: line?.period?.end ? new Date(line.period.end * 1000) : null,
      stripeCouponId: invoice.discount?.coupon?.id ?? null,
      source: "webhook",
    });
    // History: a Stripe auto-renewal charge (`subscription_cycle` = the
    // recurring cycle invoice, vs create/update bookkeeping invoices).
    if (invoice.billing_reason === "subscription_cycle" && invoice.amount_paid > 0) {
      const renewedProfile = await (await currentTenant()).profile.findFirst({
        where: { stripeCustomerId: invoice.customer },
        select: { userId: true, subscriptionPlanId: true },
      });
      if (renewedProfile) {
        void recordPlanEvent({
          userId: renewedProfile.userId,
          type: "renewed",
          fromPlanId: renewedProfile.subscriptionPlanId,
          toPlanId: renewedProfile.subscriptionPlanId,
          amountCents: invoice.amount_paid,
          note: "Plan auto-renewed for a new billing period",
        });
      }
    }
  } else if (event.type === "charge.refunded") {
    // A refund undoes the brand's addon share of that invoice in the same
    // proportion. Stripe's `amount_refunded` is cumulative, so a replayed
    // or repeated event books nothing new.
    const charge = event.data.object as {
      id: string;
      invoice?: string | { id: string } | null;
      amount: number;
      amount_refunded: number;
    };
    const invoiceId =
      typeof charge.invoice === "string" ? charge.invoice : (charge.invoice?.id ?? null);
    if (invoiceId) {
      await reverseCreditForRefund({
        invoiceId,
        chargeId: charge.id,
        chargeAmountCents: charge.amount,
        amountRefundedCents: charge.amount_refunded,
      });
      await recordRefund({
        invoiceId,
        chargeAmountCents: charge.amount,
        amountRefundedCents: charge.amount_refunded,
      });
    }
  } else if (event.type === "checkout.session.completed") {
    const session = event.data.object as { customer_email?: string | null };
    const email = session.customer_email;
    if (email) {
      const user = await (await currentTenant()).user.findUnique({
        where: { email },
        include: { profile: true },
      });
      if (user?.profile) {
        await (await currentTenant()).profile.update({
          where: { userId: user.id },
          data: { plan: "premium" },
        });
      }
    }
  }
}

router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  asyncHandler(async (req, res) => {
    // Stripe not configured: acknowledge without processing.
    if (!isStripeConfigured()) {
      res.json({ received: true });
      return;
    }

    // Refuse to process webhooks we can't verify — an unsigned payload is untrusted.
    if (!stripeWebhookSecret()) {
      res.status(400).json({ error: "Stripe webhook secret not configured" });
      return;
    }

    const sig = req.headers["stripe-signature"] as string;

    let event;
    try {
      event = constructEvent(req.body as Buffer, sig);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid webhook signature";
      res.status(400).json({ error: message });
      return;
    }

    try {
      // Every event is first PLACED: which brand holds this Stripe customer?
      // One that no brand holds is parked for the super admin — never applied
      // to the wrong account, never dropped. Stripe is told "received" either
      // way, so it does not retry a payment we have kept.
      const customerId = customerIdOf(event.data.object);
      if (customerId && isRoutedEventType(event.type)) {
        const owner = await resolveStripeCustomer(customerId);
        if (!owner) {
          await parkUnroutedEvent(event, "No brand holds this Stripe customer.");
          res.json({ received: true });
          return;
        }
        await runWithBrand(owner.brandId, () => processStripeEvent(event));
      } else {
        await processStripeEvent(event);
      }
    } catch {
      // Never 500 on webhook processing — Stripe will otherwise retry.
    }

    res.json({ received: true });
  }),
);

router.get(
  "/portal",
  requireAuth,
  asyncHandler(async (req, res) => {
    const profile = await (await requestTenant(req)).profile.findUnique({ where: { userId: req.user!.sub } });
    if (!isStripeConfigured()) throw badRequest("Stripe is not configured");
    if (!profile?.stripeCustomerId)
      throw badRequest("No billing account found — start a subscription first");

    const session = await stripe().billingPortal.sessions.create({
      customer: profile.stripeCustomerId,
      // Back to the origin this customer actually came from. Unlike an OAuth
      // redirect_uri, Stripe takes this per session rather than pre-registered,
      // so a white-label tenant needs no Stripe configuration of its own.
      return_url: brandAppUrl("/dashboard/settings", req.user!.brandId ?? null),
    });
    res.json({ url: session.url });
  }),
);

/** Subscription details for the settings page. */
router.get(
  "/subscription",
  requireAuth,
  asyncHandler(async (req, res) => {
    // Sync any change made in the Stripe hosted portal (cancel / renew-plan)
    // first, so the page never shows a stale status or auto-renew flag. Forced
    // past the throttle: this is the page users land on straight from the
    // portal, and it's low-traffic enough to afford the live Stripe read.
    await reconcileSubscription(req.user!.sub, new Date(), { forcePortalSync: true });

    const profile = await withPlan(await (await requestTenant(req)).profile.findUnique({
      where: { userId: req.user!.sub } }));
    if (!profile) {
      res.json({ subscription: null });
      return;
    }

    // Pending downgrade (if any) → tell the user what they'll move to and when.
    let scheduledPlan: { id: string; name: string; effectiveAt: string | null } | null = null;
    if (profile.scheduledPlanId) {
      const sp = await prisma.subscriptionPlan.findUnique({
        where: { id: profile.scheduledPlanId },
        select: { id: true, displayName: true },
      });
      if (sp) {
        scheduledPlan = {
          id: sp.id,
          name: sp.displayName,
          effectiveAt: profile.scheduledPlanEffectiveAt?.toISOString() ?? null,
        };
      }
    }

    // Whether the user's current plan is now a legacy (deactivated) plan.
    const planActive = profile.subscriptionPlanId
      ? (
          await prisma.subscriptionPlan.findUnique({
            where: { id: profile.subscriptionPlanId },
            select: { active: true },
          })
        )?.active ?? true
      : true;

    // Live coupon discount, so Plans & Billing can show what's applied and how
    // much of it is left.
    const live = await getActiveRedemption(req.user!.sub);
    const discount = live
      ? {
          code: live.coupon.code,
          displayName: live.coupon.displayName,
          percentOff: live.coupon.percentOff,
          bonusMinutes: live.coupon.bonusMinutes,
          cyclesUsed: live.cyclesUsed,
          durationCycles: live.coupon.durationCycles,
          cyclesLeft: Math.max(0, live.coupon.durationCycles - live.cyclesUsed),
        }
      : null;

    res.json({
      subscription: {
        status: profile.subscriptionStatus,
        planId: profile.subscriptionPlanId,
        discount,
        planName: profile.subscriptionPlan?.displayName ?? null,
        // What THIS customer is billed: base + the brand's addon when their
        // subscription is on the brand's Price, the base otherwise.
        priceCents:
          profile.subscriptionPlan && profile.subscriptionPlanId
            ? await customerPlanPriceCents({
                plan: { id: profile.subscriptionPlanId, priceCents: profile.subscriptionPlan.priceCents },
                brandId: req.user!.brandId,
                stripeSubscriptionId: profile.stripeSubscriptionId,
              })
            : 0,
        currency: profile.subscriptionPlan?.currency ?? "usd",
        interval: profile.subscriptionPlan?.interval ?? "month",
        intervalCount: profile.subscriptionPlan?.intervalCount ?? 1,
        includedMinutes: profile.subscriptionPlan?.includedMinutes ?? 0,
        smsEnabled: profile.subscriptionPlan?.smsEnabled ?? false,
        smsToCallerEnabled: profile.subscriptionPlan?.smsToCallerEnabled ?? false,
        whatsappEnabled: profile.subscriptionPlan?.whatsappEnabled ?? false,
        customCrmEnabled: profile.subscriptionPlan?.customCrmEnabled ?? false,
        multilingualEnabled: profile.subscriptionPlan?.multilingualEnabled ?? false,
        callTransferEnabled: profile.subscriptionPlan?.callTransferEnabled ?? false,
        callTransferLimit: profile.subscriptionPlan?.callTransferLimit ?? 0,
        currentPeriodEnd: profile.currentPeriodEnd?.toISOString() ?? null,
        trialEndsAt: profile.trialEndsAt?.toISOString() ?? null,
        autoRenew: profile.autoRenew,
        legacy: !planActive,
        scheduledPlan,
      },
    });
  }),
);

/**
 * Toggle auto-renew. Off → the plan/trial ends at the current period with no
 * further charge (Stripe cancel_at_period_end), then the account is frozen
 * (calls blocked) until the user picks a plan again. On → renews + charges as
 * normal. Stored on the profile and mirrored onto the Stripe subscription.
 */
router.post(
  "/auto-renew",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const userId = req.user!.sub;
    const profile = await (await requestTenant(req)).profile.findUnique({ where: { userId } });
    if (!profile?.stripeSubscriptionId)
      throw badRequest("You don't have an active subscription to change.");

    // Turning auto-renew off on a subscription with a pending downgrade forces
    // Stripe to release the downgrade schedule (it blocks cancelation changes on
    // scheduled subs). Nothing is lost that could still happen — with no next
    // cycle there is no cycle to downgrade into — but our mirrored record of the
    // pending change has to go too, or the UI keeps promising a plan switch that
    // Stripe no longer has.
    let droppedDowngrade = false;
    if (isStripeConfigured()) {
      try {
        const { releasedScheduleId } = await setSubscriptionAutoRenew(
          profile.stripeSubscriptionId,
          enabled,
        );
        droppedDowngrade = !!releasedScheduleId && !!profile.scheduledPlanId;
      } catch (e) {
        throw badRequest(
          e instanceof Error ? e.message : "Couldn't update auto-renew with the payment provider.",
        );
      }
    }
    await (await requestTenant(req)).profile.update({
      where: { userId },
      data: droppedDowngrade
        ? { autoRenew: enabled, scheduledPlanId: null, scheduledPlanEffectiveAt: null, stripeScheduleId: null }
        : { autoRenew: enabled },
    });

    if (droppedDowngrade) {
      void recordPlanEvent({
        userId,
        type: "downgrade_canceled",
        fromPlanId: profile.scheduledPlanId,
        toPlanId: profile.subscriptionPlanId,
        note: "Pending downgrade dropped because auto-renew was turned off — the plan now ends at the current period instead",
      });
    }

    // History for the admin timeline — only on a real flip, not a no-op toggle.
    if (profile.autoRenew !== enabled) {
      void recordPlanEvent({
        userId,
        type: enabled ? "auto_renew_on" : "auto_renew_off",
        fromPlanId: profile.subscriptionPlanId,
        note: enabled
          ? "Auto-renew turned back on from Plans & Billing"
          : "Auto-renew turned off from Plans & Billing — plan ends at the current period, no further charge",
      });
    }

    res.json({
      ok: true,
      autoRenew: enabled,
      droppedDowngrade,
      message: enabled
        ? "Auto-renew is on. Your plan will renew and charge your saved card automatically when the period ends."
        : droppedDowngrade
          ? "Auto-renew is off. Your plan will end when the current period finishes — no further charge — and calls pause until you pick a plan again. Your scheduled plan change was cancelled, since there's no next cycle to move into."
          : "Auto-renew is off. Your plan will end when the current period finishes — no further charge — and calls pause until you pick a plan again.",
    });
  }),
);

/**
 * Renew the current plan NOW — for a user whose plan is blocked because minutes
 * ran out (auto-renew off) or a payment lapsed (past_due). Charges the saved card
 * for a fresh full period, resets minutes, turns auto-renew back on, and unfreezes
 * the line. Unlike /subscribe, it keeps the same plan and never restarts a trial.
 */
router.post(
  "/renew",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!isStripeConfigured()) throw notImplemented("Stripe is not configured");
    const userId = req.user!.sub;
    const profile = await withPlan(await (await requestTenant(req)).profile.findUnique({
      where: { userId } }));
    if (!profile?.stripeCustomerId || !profile.subscriptionPlanId || !profile.subscriptionPlan)
      throw badRequest("You don't have a plan to renew — choose a plan instead.");
    if (!profile.subscriptionPlan.stripePriceId)
      throw badRequest("This plan isn't linked to Stripe yet.");
    const renewPriceId =
      (await stripePriceIdFor(profile.subscriptionPlan, req.user!.brandId)) ??
      profile.subscriptionPlan.stripePriceId;
    // A card-required account that has never confirmed a card has nothing to
    // renew: /subscribe already gave it a customer id, a plan id and a pending
    // trial subscription, which is everything the guard above checks. Without
    // this it would reach endTrialNow, fail against a customer with no payment
    // method, and the catch below would persist "past_due" — moving the account
    // off its wall-adjacent state and, before the wall was keyed on
    // cardConfirmedAt, opening the dashboard. Send them to add a card instead.
    if (profile.cardRequiredAtSignup && !profile.cardConfirmedAt)
      throw badRequest("Add your card to start your plan.");

    // Is the existing Stripe subscription still alive? If auto-renew was off and the
    // period lapsed, Stripe already canceled it — then we create a fresh subscription
    // on the same plan instead of trying to revive a dead one.
    const live = profile.stripeSubscriptionId
      ? await getSubscription(profile.stripeSubscriptionId).catch(() => null)
      : null;
    const canReuse = !!live && ["active", "past_due", "trialing"].includes(live.status);

    let currentPeriodEnd: number | null = null;
    let activeSubscriptionId = profile.stripeSubscriptionId ?? "";
    // Set when the early renewal had to release a pending-downgrade schedule —
    // the queued change is gone from Stripe, so our mirror of it must go too.
    let releasedDowngrade = false;
    try {
      if (live?.status === "trialing") {
        // Trial blocked (minutes used up, auto-renew off) → end the trial NOW so the
        // saved card is charged and the paid plan starts immediately.
        await setSubscriptionAutoRenew(profile.stripeSubscriptionId!, true);
        await endTrialNow(profile.stripeSubscriptionId!);
        const after = await getSubscription(profile.stripeSubscriptionId!);
        if (after.status !== "active") throw new Error("not active after ending trial");
        currentPeriodEnd = after.currentPeriodEnd;
      } else if (canReuse) {
        // Existing paid sub still alive → clear any pending cancel + charge a fresh period.
        await setSubscriptionAutoRenew(profile.stripeSubscriptionId!, true);
        const renewed = await renewSubscriptionNow(profile.stripeSubscriptionId!);
        currentPeriodEnd = renewed.currentPeriodEnd;
        releasedDowngrade = !!renewed.releasedScheduleId;
        if (!renewed.active) throw new Error("not active after renewal");
      } else {
        // Subscription ended/canceled → start a fresh one on the same plan, charged now.
        const created = await createImmediateSubscription(
          profile.stripeCustomerId,
          renewPriceId,
        );
        activeSubscriptionId = created.subscriptionId;
        currentPeriodEnd = created.currentPeriodEnd;
        if (!created.active) throw new Error("not active after subscribe");
      }
    } catch (e) {
      // Log the real upstream reason — the user-facing copy below is deliberately
      // generic, so without this a failed renew is undiagnosable.
      console.error(`[billing] renew failed for user ${userId}:`, e instanceof Error ? e.message : e);
      await (await requestTenant(req)).profile
        .update({ where: { userId }, data: { subscriptionStatus: "past_due", plan: "free" } })
        .catch(() => {});
      throw badRequest(
        e instanceof Error && /card|declined|payment|incomplete/i.test(e.message)
          ? "We couldn't charge your saved card. Update it and try again."
          : "We couldn't renew your plan right now. Please try again.",
      );
    }

    await (await requestTenant(req)).profile.update({
      where: { userId },
      data: {
        subscriptionStatus: "active",
        plan: "premium",
        autoRenew: true,
        stripeSubscriptionId: activeSubscriptionId,
        ...(releasedDowngrade
          ? { scheduledPlanId: null, scheduledPlanEffectiveAt: null, stripeScheduleId: null }
          : {}),
      },
    });
    const renewedPeriodEnd = currentPeriodEnd ? new Date(currentPeriodEnd * 1000) : null;
    await applyActivePlanMinutes(userId, {
      includedMinutes: await effectiveIncludedMinutes(
        userId,
        profile.subscriptionPlan?.includedMinutes ?? 0,
      ),
      periodEnd: renewedPeriodEnd,
      // The card was just charged for a full fresh period — always a new cycle,
      // stated explicitly rather than inferred from the period end.
      resetUsage: true,
    });
    // The invoice this renewal settled — read first so the coupon cycle keys on
    // it rather than on the period end alone.
    const inv = await getLatestPaidInvoice(activeSubscriptionId);
    // A manual renewal is still a charged cycle, so it spends one of the
    // coupon's — counted after the grant, like every other charge path.
    await consumeCycle(userId, activeSubscriptionId, renewedPeriodEnd, inv?.id ?? null);
    // Re-route the number + reset the per-call cap so the AI answers again.
    void syncAssistantCallCap(userId).catch(() => {});
    // Accrue the reseller's commission for the renewal charge (idempotent).
    if (inv) {
      await accrueCommissionForInvoice({
        invoiceId: inv.id,
        customerId: inv.customerId,
        amountPaidCents: inv.amountPaidCents,
      });
      await recordPaidInvoice({
        invoiceId: inv.id,
        customerId: inv.customerId,
        amountPaidCents: inv.amountPaidCents,
        priceId: inv.priceId,
        source: "renewal",
      });
    }

    void recordPlanEvent({
      userId,
      type: "renewed",
      fromPlanId: profile.subscriptionPlanId,
      toPlanId: profile.subscriptionPlanId,
      amountCents: inv?.amountPaidCents ?? 0,
      note: "Plan renewed manually by the customer",
    });

    res.json({
      ok: true,
      message: `Your ${profile.subscriptionPlan?.displayName ?? "plan"} is renewed and active again — auto-renew is back on.`,
    });
  }),
);

/* --------------------- Plan change (upgrade / downgrade) ------------------- */

/**
 * What the customer has actually paid toward the CURRENT cycle, or undefined
 * when we can't tell.
 *
 * Two components, because money reaches us two ways:
 *  - the subscription invoice — `amount_paid`, i.e. AFTER any coupon; and
 *  - upgrade deltas, which are standalone invoices charged mid-cycle
 *    (`chargeOneTime`) and so never appear on the subscription's invoice list.
 *
 * Missing the second part would under-credit anyone upgrading twice in one
 * cycle: they'd have paid the first delta up to the new plan's full price, but
 * we'd still be crediting them against the original discounted charge.
 */
async function paidThisCycleCents(
  userId: string,
  subscriptionId: string,
): Promise<number | undefined> {
  const invoice = await getLatestPaidInvoice(subscriptionId).catch(() => null);
  // No paid invoice at all (free trial, or Stripe unreachable) — say "unknown"
  // rather than "zero", so the caller falls back to the plan price instead of
  // silently crediting nothing.
  if (!invoice) return undefined;
  const deltas = await tenantForUser(userId)
    .then((db) =>
      db.planEvent.aggregate({
        _sum: { amountCents: true },
        where: { userId, type: "upgraded", amountCents: { gt: 0 }, createdAt: { gt: invoice.createdAt } },
      }),
    )
    .catch(() => null);
  return invoice.amountPaidCents + (deltas?._sum?.amountCents ?? 0);
}

/** Resolve current + target plan and the user's live minute usage for a change. */
async function loadPlanChangeContext(userId: string, targetPlanId: string) {
  const profile = await withPlan(await (await tenantForUser(userId)).profile.findUnique({
    where: { userId } }));
  if (!profile) throw notFound("Profile not found");
  if (!profile.stripeSubscriptionId || !profile.stripeCustomerId)
    throw badRequest("You don't have an active subscription to change.");
  // The brand's addon rides on top of the platform price; the brand is the customer's.
  const brandId = await brandIdForOwner(userId);

  const current = profile.subscriptionPlan;
  if (!current) throw badRequest("No current plan to change from.");
  if (current.id === targetPlanId) throw badRequest("That's already your current plan.");

  const target = await prisma.subscriptionPlan.findUnique({ where: { id: targetPlanId } });
  if (!target || !target.active) throw badRequest("That plan isn't available.");
  if (!target.stripePriceId) throw badRequest("That plan isn't linked to Stripe yet.");
  // The Price the swap lands on: the brand's own when this customer's brand
  // adds a charge to the target plan, else the platform's.
  const targetPriceId = (await stripePriceIdFor(target, brandId)) ?? target.stripePriceId;

  // Stripe fixes a subscription's currency when it is created, so a price in a
  // different currency cannot be swapped in — the update is rejected outright.
  //
  // Refused HERE, in the shared context loader, so it stops the preview as well
  // as the apply. Without it the change ran all the way to Stripe and failed at
  // the swap, which is AFTER the charge step — the customer saw "we took the
  // payment but couldn't switch your plan". It also stopped the two prices being
  // compared as if they were the same unit: $20 AUD against $20 USD came out as
  // "same price", and a $30 USD plan would have read as an upgrade over $20 AUD
  // purely on the number.
  if (target.currency !== current.currency) {
    throw badRequest(
      `${target.displayName} is priced in ${target.currency.toUpperCase()} and your subscription bills in ${current.currency.toUpperCase()}. A subscription can't change currency — please contact support to move to this plan.`,
    );
  }

  // Call Transfer departments have to fit the TARGET plan before the change can
  // go through. Refused HERE, in the shared loader, so the preview stops it too:
  // the customer reads why in the plan modal instead of discovering it after the
  // card has been charged.
  //
  // We never trim their departments to make room. Which ones to lose is a
  // business decision only they can make, and silently deleting configuration
  // someone set up is not a thing a downgrade should do.
  const targetDepartments = transferDepartmentAllowance(target);
  // Departments live in the customer's brand's database.
  const departmentCount = await (await tenantForUser(userId)).transferDepartment.count({
    where: { userId },
  });
  if (departmentCount > targetDepartments) {
    const plural = (n: number) => (n === 1 ? "" : "s");
    throw badRequest(
      targetDepartments === 0
        ? `${target.displayName} doesn't include Call Transfer, and you have ${departmentCount} transfer department${plural(departmentCount)} set up. Please delete them under Call Transfer before switching to this plan.`
        : `${target.displayName} allows ${targetDepartments} transfer department${plural(targetDepartments)}, and you have ${departmentCount}. Please remove ${departmentCount - targetDepartments} under Call Transfer before switching to this plan.`,
    );
  }

  // Price the change the way this customer is actually billed: base + the
  // brand's addon on whichever side really sits on the brand's Price. The
  // proration below and the preview's figures then match the invoices Stripe
  // will raise. Mutated in place so every later reader of these plans agrees.
  if (brandId) {
    const [targetAddon, currentAddon] = await Promise.all([
      brandAddonOnPrice(target.id, brandId, targetPriceId),
      brandAddonOnPrice(current.id, brandId, await livePriceId(profile.stripeSubscriptionId)),
    ]);
    target.priceCents += targetAddon;
    current.priceCents += currentAddon;
  }

  const ent = await getEntitlement(userId);
  const proration = computeProration({
    currentPriceCents: current.priceCents,
    newPriceCents: target.priceCents,
    minutesAllocated: ent.minutesAllocated,
    minutesRemaining: ent.minutesRemaining,
    paidCents: await paidThisCycleCents(userId, profile.stripeSubscriptionId),
  });

  return { profile, current, target, ent, proration, targetPriceId };
}

/* ----------------------- Cross-currency plan switch ----------------------- *
 *
 * `/change-plan` refuses a currency change on purpose: Stripe fixes a customer's
 * currency at its first invoice, so a price in another currency cannot be swapped
 * onto an existing subscription — the update is rejected outright.
 *
 * The only route is a NEW customer with a NEW subscription, paid with a
 * re-entered card (payment methods cannot move between customers). That is two
 * Stripe writes with no transaction around them, so ORDER is the whole design:
 *
 *    start   → create the new subscription unpaid, keep the old one LIVE
 *    (client confirms the PaymentIntent with a card)
 *    confirm → new subscription is active → only NOW cancel the old one
 *
 * Done the other way round, a declined card leaves the customer with nothing.
 * Here the worst case is a customer who still has exactly what they had before.
 * ------------------------------------------------------------------------- */

/** Drop a half-finished switch, cancelling its Stripe subscription. Best-effort:
 *  Stripe also expires unpaid incomplete subscriptions on its own after ~23h, so
 *  a failure here delays cleanup rather than leaking a live subscription. */
async function clearPendingSwitch(userId: string, subscriptionId: string | null): Promise<void> {
  if (subscriptionId) {
    await cancelSubscription(subscriptionId).catch(() => {
      /* Stripe expires unpaid incompletes by itself — never block the user */
    });
  }
  await (await tenantForUser(userId)).profile.update({
    where: { userId },
    data: {
      pendingSwitchCustomerId: null,
      pendingSwitchSubscriptionId: null,
      pendingSwitchPlanId: null,
      pendingSwitchStartedAt: null,
    },
  });
}

/**
 * Begin a currency switch. Creates the new customer + unpaid subscription and
 * returns a PaymentIntent secret for the client to confirm. Charges nothing and
 * changes nothing about the customer's current plan.
 */
router.post(
  "/switch-currency/start",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!isStripeConfigured()) throw notImplemented("Stripe is not configured");
    const { planId } = z.object({ planId: z.string().min(1) }).parse(req.body);
    const userId = req.user!.sub;

    const profile = await withPlan(await (await requestTenant(req)).profile.findUnique({
      where: { userId } }));
    if (!profile) throw notFound("Profile not found");
    const current = profile.subscriptionPlan;
    if (!current || !profile.stripeSubscriptionId) {
      throw badRequest("You don't have an active subscription to switch.");
    }
    // A trial has nothing to preserve and nothing to cancel around, and this flow
    // charges immediately — running it mid-trial would bill the customer today
    // and burn the free days they have left. `/subscribe` already handles a
    // trialing customer picking another currency (it mints a fresh customer and
    // keeps the trial clock), so send them there instead.
    if (profile.subscriptionStatus === "trialing") {
      throw badRequest(
        "You're still on your free trial — pick the plan you want from the plan list and your trial carries over.",
      );
    }

    const target = await prisma.subscriptionPlan.findUnique({ where: { id: planId } });
    if (!target || !target.active) throw badRequest("That plan isn't available.");
    if (!target.stripePriceId) throw badRequest("That plan isn't linked to Stripe yet.");
    if (target.id === current.id) throw badRequest("That's already your current plan.");
    // Same currency needs none of this — /change-plan does it in place, keeping
    // the customer's saved card and their proration credit.
    if (target.currency === current.currency) {
      throw badRequest("That plan is in your current currency — change it from the plan list instead.");
    }

    // A second "start" replaces the first rather than stacking unpaid
    // subscriptions on abandoned customers.
    if (profile.pendingSwitchSubscriptionId) {
      await clearPendingSwitch(userId, profile.pendingSwitchSubscriptionId);
    }

    const { customerId, subscriptionId, clientSecret } = await createCurrencySwitchSubscription({
      email: req.user!.email,
      owner: { brandId: req.user!.brandId, userId },
      priceId: (await stripePriceIdFor(target, req.user!.brandId)) ?? target.stripePriceId,
    });
    // Indexed at once, before it has paid anything: the first invoice's
    // webhook must already know whose customer this is.
    await indexStripeCustomer(customerId, { brandId: req.user!.brandId, userId });

    await (await requestTenant(req)).profile.update({
      where: { userId },
      data: {
        pendingSwitchCustomerId: customerId,
        pendingSwitchSubscriptionId: subscriptionId,
        pendingSwitchPlanId: target.id,
        pendingSwitchStartedAt: new Date(),
      },
    });

    res.json({
      clientSecret,
      subscriptionId,
      plan: {
        id: target.id,
        name: target.displayName,
        priceCents: target.priceCents,
        currency: target.currency,
        interval: target.interval,
        includedMinutes: target.includedMinutes,
      },
      // Spelled out for the confirmation screen: this is a fresh subscription,
      // not a swap, so there is no proration credit for the old plan's unused
      // time — Stripe cannot credit across currencies.
      losesRemainingTime: true,
      currentPlan: { name: current.displayName, currency: current.currency },
    });
  }),
);

/**
 * Finish a currency switch, once the client has confirmed the PaymentIntent.
 * Verifies with Stripe that the new subscription is genuinely paid BEFORE the
 * old one is cancelled — the client saying so is not evidence.
 */
router.post(
  "/switch-currency/confirm",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!isStripeConfigured()) throw notImplemented("Stripe is not configured");
    const userId = req.user!.sub;

    const profile = await withPlan(await (await requestTenant(req)).profile.findUnique({
      where: { userId } }));
    if (!profile?.pendingSwitchSubscriptionId || !profile.pendingSwitchPlanId) {
      throw badRequest("No plan switch is in progress.");
    }

    const target = await prisma.subscriptionPlan.findUnique({
      where: { id: profile.pendingSwitchPlanId },
    });
    if (!target) throw badRequest("That plan no longer exists.");

    // Trust Stripe, not the caller. Anyone can POST here; only a genuinely
    // active subscription may cancel the one the customer is currently paying.
    const sub = await getSubscription(profile.pendingSwitchSubscriptionId);
    if (sub.status !== "active" && sub.status !== "trialing") {
      throw badRequest("That payment hasn't gone through yet. Please complete the card step.");
    }

    const previousSubscriptionId = profile.stripeSubscriptionId;
    const previousPlan = profile.subscriptionPlan;
    const periodEnd = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd * 1000) : null;
    await (await requestTenant(req)).profile.update({
      where: { userId },
      data: {
        stripeCustomerId: profile.pendingSwitchCustomerId,
        stripeSubscriptionId: profile.pendingSwitchSubscriptionId,
        subscriptionPlanId: target.id,
        subscriptionStatus: "active",
        autoRenew: true,
        currentPeriodEnd: periodEnd,
        // A downgrade queued against the OLD subscription refers to a schedule on
        // a customer that no longer bills this account — drop it with the rest.
        scheduledPlanId: null,
        scheduledPlanEffectiveAt: null,
        stripeScheduleId: null,
        pendingSwitchCustomerId: null,
        pendingSwitchSubscriptionId: null,
        pendingSwitchPlanId: null,
        pendingSwitchStartedAt: null,
      },
    });

    // Cancel the old subscription only now that the profile already points at the
    // new one. Order matters twice over:
    //
    //  • Stripe fires customer.subscription.deleted for the cancelled one, and
    //    that handler matches a profile by subscription OR customer id. Cancelling
    //    first raced the profile update — the webhook found the account still
    //    holding the old ids and flipped a freshly-active subscription back to
    //    "canceled".
    //  • If this call fails, the customer is briefly billed twice, which is
    //    visible and refundable. The other order fails the other way: a paid
    //    customer left pointing at a cancelled subscription, with no service.
    if (previousSubscriptionId) {
      await cancelSubscription(previousSubscriptionId).catch((e) => {
        console.error(
          `[billing] currency switch: user ${userId} is on ${target.displayName} but the old subscription ${previousSubscriptionId} was NOT cancelled — cancel it in Stripe to stop double billing:`,
          e,
        );
      });
    }

    // Fresh subscription, fresh cycle — the new plan's minutes start now.
    await applyActivePlanMinutes(userId, {
      includedMinutes: target.includedMinutes,
      periodEnd,
      resetUsage: true,
    });

    void recordPlanEvent({
      userId,
      type: "plan_switched",
      fromPlanId: previousPlan?.id ?? null,
      fromPlanName: previousPlan?.displayName ?? null,
      toPlanId: target.id,
      toPlanName: target.displayName,
      priceCents: target.priceCents,
      currency: target.currency,
      note: previousPlan
        ? `Currency switch: ${previousPlan.currency.toUpperCase()} → ${target.currency.toUpperCase()} (new subscription, no proration)`
        : "Currency switch",
    });

    void provisionAgentForUser(userId).catch(() => {});

    res.json({ ok: true, planId: target.id, planName: target.displayName });
  }),
);

/** Abandon a switch. The customer's existing subscription was never touched, so
 *  this only tidies up the half-built one. */
router.post(
  "/switch-currency/cancel",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.sub;
    const profile = await (await requestTenant(req)).profile.findUnique({ where: { userId } });
    if (profile?.pendingSwitchSubscriptionId) {
      await clearPendingSwitch(userId, profile.pendingSwitchSubscriptionId);
    }
    res.json({ ok: true });
  }),
);

const planChangeSchema = z.object({ planId: z.string().min(1) });

/** Preview a plan change — credit, exact amount due, direction, effective date. No charge. */
router.post(
  "/change-plan/preview",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { planId } = planChangeSchema.parse(req.body);
    const { profile, current, target, ent, proration } = await loadPlanChangeContext(
      req.user!.sub,
      planId,
    );
    const isTrial = profile.subscriptionStatus === "trialing";

    // If a downgrade is already pending, tell the client which plan this change
    // would replace/cancel so the modal can spell it out.
    let replacesScheduledPlanName: string | null = null;
    if (profile.scheduledPlanId && profile.scheduledPlanId !== target.id) {
      replacesScheduledPlanName =
        (
          await prisma.subscriptionPlan.findUnique({
            where: { id: profile.scheduledPlanId },
            select: { displayName: true },
          })
        )?.displayName ?? null;
    }

    res.json({
      direction: proration.direction,
      isTrial,
      currentPlan: { id: current.id, name: current.displayName, priceCents: current.priceCents },
      newPlan: { id: target.id, name: target.displayName, priceCents: target.priceCents, includedMinutes: target.includedMinutes },
      minutesAllocated: ent.minutesAllocated,
      minutesRemaining: ent.minutesRemaining,
      // During a trial nothing is charged now — the new plan price applies at trial end.
      creditCents: isTrial ? 0 : proration.creditCents,
      amountDueCents: isTrial ? 0 : proration.amountDueCents,
      currency: current.currency,
      currentPeriodEnd: profile.currentPeriodEnd?.toISOString() ?? null,
      trialEndsAt: profile.trialEndsAt?.toISOString() ?? null,
      replacesScheduledPlanName,
      effectiveAt: isTrial
        ? profile.trialEndsAt?.toISOString() ?? null
        : proration.direction === "downgrade"
          ? profile.currentPeriodEnd?.toISOString() ?? null
          : null, // upgrade = immediate
    });
  }),
);

/** Apply a plan change. Upgrade = immediate (charge delta, grant minutes now);
 *  downgrade = scheduled at period end; trial = swap the post-trial plan. */
router.post(
  "/change-plan",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!isStripeConfigured()) throw notImplemented("Stripe is not configured");
    const { planId } = planChangeSchema.parse(req.body);
    const userId = req.user!.sub;
    const { profile, current, target, proration, targetPriceId } = await loadPlanChangeContext(userId, planId);
    const subId = profile.stripeSubscriptionId!;
    const newPriceId = targetPriceId;

    // Any pending downgrade must be released first: a subscription attached to a
    // schedule can't be price-swapped (upgrade/trial) and re-scheduling a different
    // downgrade would otherwise collide with the existing schedule.
    if (profile.stripeScheduleId) await releaseSchedule(profile.stripeScheduleId);

    // Trial: no charge now — just switch which plan activates when the trial ends.
    if (profile.subscriptionStatus === "trialing") {
      await swapSubscriptionPriceNow(subId, newPriceId);
      await (await requestTenant(req)).profile.update({
        where: { userId },
        data: { subscriptionPlanId: target.id, scheduledPlanId: null, scheduledPlanEffectiveAt: null },
      });
      void recordPlanEvent({
        userId,
        type: "plan_switched",
        fromPlanId: current.id,
        fromPlanName: current.displayName,
        toPlanId: target.id,
        toPlanName: target.displayName,
        priceCents: target.priceCents,
        currency: target.currency,
        note: "Post-trial plan swapped during the free trial (no charge)",
      });
      res.json({
        ok: true,
        direction: proration.direction,
        message: `Your plan will switch to ${target.displayName} when your free trial ends. You won't be charged until then.`,
      });
      return;
    }

    if (proration.direction === "downgrade") {
      // Keep current plan + minutes until period end; Stripe bills the lower price next cycle.
      const { scheduleId, effectiveAt } = await scheduleDowngrade(subId, newPriceId);
      await (await requestTenant(req)).profile.update({
        where: { userId },
        data: {
          scheduledPlanId: target.id,
          scheduledPlanEffectiveAt: effectiveAt ? new Date(effectiveAt * 1000) : profile.currentPeriodEnd,
          stripeScheduleId: scheduleId,
        },
      });
      const effective = effectiveAt ? new Date(effectiveAt * 1000) : profile.currentPeriodEnd;
      void recordPlanEvent({
        userId,
        type: "downgrade_scheduled",
        fromPlanId: current.id,
        fromPlanName: current.displayName,
        toPlanId: target.id,
        toPlanName: target.displayName,
        priceCents: target.priceCents,
        currency: target.currency,
        note: `Downgrade scheduled for ${effective ? formatDateDMY(effective) : "the period end"} (no charge today)`,
      });
      const when = effective ? formatDateDMY(effective) : undefined;
      res.json({
        ok: true,
        direction: "downgrade",
        message: `You'll stay on ${current.displayName} until ${when ?? "the period end"}, then move to ${target.displayName}. No charge today.`,
      });
      return;
    }

    // Upgrade (or same-price switch): COLLECT FIRST, then apply the plan.
    // The swap used to run first, so a failed collection left the customer on the
    // upgraded price in Stripe while we threw an error and never wrote our own DB
    // row — they held a plan they hadn't paid for and our records disagreed with
    // Stripe. Charging first means a decline simply leaves everything as it was.
    let charged = 0;
    if (proration.amountDueCents > 0) {
      const { paid } = await chargeOneTime(
        profile.stripeCustomerId!,
        proration.amountDueCents,
        `Upgrade to ${target.displayName} (credit ${(proration.creditCents / 100).toFixed(2)} for unused minutes)`,
        current.currency,
      );
      if (!paid) throw badRequest("We couldn't collect the upgrade charge on your card. Please update your card and try again.");
      charged = proration.amountDueCents;
    }
    try {
      await swapSubscriptionPriceNow(subId, newPriceId);
    } catch (e) {
      // Money is in, the price swap isn't. Never silently keep the payment: log
      // loudly with the amount so it can be refunded, and tell the user plainly.
      console.error(
        `[billing] price swap failed for user ${userId} (charged ${charged} ${current.currency}):`,
        e instanceof Error ? e.message : e,
      );
      // A same-price switch charges nothing (amountDueCents is 0 unless the
      // direction is "upgrade"), so this path is reached with charged === 0 too.
      // Telling that customer we took their money and owe them a refund sends
      // them — and support — hunting for a payment that never happened.
      throw badRequest(
        charged > 0
          ? "We took the upgrade payment but couldn't switch your plan. Our team has been notified and will fix this or refund you."
          : "We couldn't switch your plan, and nothing was charged. Our team has been notified.",
      );
    }
    await (await requestTenant(req)).profile.update({
      where: { userId },
      data: { subscriptionPlanId: target.id, scheduledPlanId: null, scheduledPlanEffectiveAt: null, stripeScheduleId: null },
    });
    // The upgrade keeps the same billing date (price swapped with
    // `proration_behavior: 'none'`), so force the usage reset: the user paid the
    // full new-plan price minus a credit for unused old-plan minutes, so the new
    // allowance starts fresh. Without `resetUsage`, minutes already spent on the
    // cheaper plan would carry over and shrink the upgraded allowance.
    // A live coupon survives a plan change — its remaining cycles are honoured
    // whichever plan the user moves to — but its BONUS MINUTES are deliberately
    // NOT re-added here. They are granted per billing cycle, and an upgrade is
    // not a new cycle: the delta is a standalone invoice, which is also why
    // there's no consumeCycle on this path. Adding them again would hand out a
    // fresh 200 minutes on top of the reset allowance, and a customer could
    // simply upgrade repeatedly to farm them. The cycle's bonus was already
    // granted at the boundary, and the unused part of the allowance came back as
    // proration credit; the next real renewal grants them again if cycles remain.
    await applyActivePlanMinutes(userId, {
      includedMinutes: target.includedMinutes,
      periodEnd: profile.currentPeriodEnd,
      resetUsage: proration.direction === "upgrade",
    });
    void syncAssistantCallCap(userId).catch(() => {});

    void recordPlanEvent({
      userId,
      type: "upgraded",
      fromPlanId: current.id,
      fromPlanName: current.displayName,
      toPlanId: target.id,
      toPlanName: target.displayName,
      priceCents: target.priceCents,
      currency: target.currency,
      amountCents: charged,
      note:
        charged > 0
          ? `Prorated upgrade charge after a ${(proration.creditCents / 100).toFixed(2)} ${current.currency.toUpperCase()} unused-minutes credit`
          : "Unused-minutes credit covered the full upgrade — nothing charged",
    });

    res.json({
      ok: true,
      direction: "upgrade",
      chargedCents: charged,
      creditCents: proration.creditCents,
      message:
        charged > 0
          ? `Upgraded to ${target.displayName}. You were charged ${(charged / 100).toFixed(2)} ${current.currency.toUpperCase()} after a ${(proration.creditCents / 100).toFixed(2)} credit for unused minutes.`
          : `Upgraded to ${target.displayName}. Your unused-minutes credit covered the full amount — nothing to pay today.`,
    });
  }),
);

/** Cancel a pending downgrade — keep the current plan. */
router.post(
  "/change-plan/cancel-downgrade",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.sub;
    const profile = await (await requestTenant(req)).profile.findUnique({ where: { userId } });
    if (!profile?.scheduledPlanId) throw badRequest("You have no pending plan change.");
    if (profile.stripeScheduleId) await releaseSchedule(profile.stripeScheduleId);
    const canceledScheduledPlanId = profile.scheduledPlanId;
    await (await requestTenant(req)).profile.update({
      where: { userId },
      data: { scheduledPlanId: null, scheduledPlanEffectiveAt: null, stripeScheduleId: null },
    });
    void recordPlanEvent({
      userId,
      type: "downgrade_canceled",
      fromPlanId: canceledScheduledPlanId,
      toPlanId: profile.subscriptionPlanId,
      note: "Pending downgrade canceled — staying on the current plan",
    });
    res.json({ ok: true, message: "Your pending downgrade was cancelled — you'll stay on your current plan." });
  }),
);

/** Recent invoices from Stripe. */
router.get(
  "/invoices",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!isStripeConfigured()) {
      res.json({ invoices: [] });
      return;
    }
    const profile = await (await requestTenant(req)).profile.findUnique({ where: { userId: req.user!.sub } });
    if (!profile?.stripeCustomerId) {
      res.json({ invoices: [] });
      return;
    }
    const invoices = await getCustomerInvoices(profile.stripeCustomerId, 12);
    res.json({ invoices });
  }),
);

export default router;
