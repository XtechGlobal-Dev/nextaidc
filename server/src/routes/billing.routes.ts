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
    // A brand sells the plans it chose (empty list = all). The brand is the request's front door.
    const allowed = brandPlanIds(req.brand);
    const plans = await prisma.subscriptionPlan.findMany({
      where: { active: true, ...(allowed.length ? { id: { in: allowed } } : {}) },
      // sortOrder first; ties broken by price, then creation time — so plans with
      // the same sort order always appear in a stable order on the subscribe page.
      orderBy: [{ sortOrder: "asc" }, { priceCents: "asc" }, { createdAt: "asc" }],
    });
    // Resolve voice-category names here — plans carry only the id and the category endpoint is admin-only.
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

/** Live coupon check for checkout, reserves nothing. Rate-limited and vague on failure — a precise "no such code" is an enumeration oracle. */
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

/** Start a trial subscription on the chosen plan. Returns a SetupIntent secret; the trial auto-charges when it ends. */
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

    // Re-validate the code. If it no longer applies, FAIL — nobody should reach the card step believing a discount applies when it doesn't.
    let coupon = null;
    if (couponCode?.trim()) {
      const result = await validateCoupon({ code: couponCode, planId, userId });
      if (!result.ok) throw badRequest(rejectionMessage(result.reason));
      coupon = result.coupon;
    }

    // Drop a reservation for a DIFFERENT code so it doesn't hold a supply slot until the sweep.
    await clearOtherPendingReservations(userId, coupon?.id ?? null);

    const profile = await (await requestTenant(req)).profile.findUnique({ where: { userId } });
    const trialDays = await getTrialDays();
    const previousCustomerId = profile?.stripeCustomerId ?? null;
    const previousSubscriptionId = profile?.stripeSubscriptionId ?? null;

    // Already trialing: swap the plan on the existing subscription, never open a second one (the orphan could
    // double-charge at trial end). Only when the currency matches — a switch falls through to the create path.
    if (profile?.subscriptionStatus === "trialing" && previousSubscriptionId && profile.subscriptionPlanId) {
      const current = await prisma.subscriptionPlan.findUnique({
        where: { id: profile.subscriptionPlanId },
      });
      if (current && current.currency === plan.currency) {
        const { clientSecret, trialEnd } = await switchTrialSubscriptionPlan(
          previousSubscriptionId,
          priceId,
        );

        // Keep the Stripe discount in step with the code the user holds now: attach it, or clear it.
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

    // Pass the plan currency so a customer locked to another currency gets a fresh Stripe customer instead of "cannot combine currencies".
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

    // Cancel the replaced subscription (currency switch, or a retry after past_due/canceled/incomplete).
    // Without this a retry left two live subscriptions and the customer could be billed twice.
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

    // Persist the PENDING subscription but don't activate the trial — /confirm-card does that once a card is on
    // file. This is the gate against trial farming by picking plans without a card.
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

/** Confirm the saved card AND start the trial — the only place it starts, so a plan chosen without a card grants nothing.
 *  Card uniqueness is deliberately not enforced; sign-up is gated by unique mobile instead. */
router.post(
  "/confirm-card",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!isStripeConfigured()) throw notImplemented("Stripe is not configured");
    const { paymentMethodId, activateNow } = z
      .object({
        paymentMethodId: z.string().min(1),
        /** Explicit "buy a plan" flow: charge and activate now instead of continuing the trial. Absent = no charge for saving a card. */
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
    // An UNATTACHED method matches nobody and used to slip through — and this handler stamps cardConfirmedAt, the card
    // wall's key, so a PaymentMethod minted with the publishable key could lift the wall. Attach it ourselves; fail closed.
    if (!customerId) {
      try {
        await attachPaymentMethod(paymentMethodId, profile.stripeCustomerId);
      } catch {
        throw badRequest("We couldn't save that card. Please try again or use another card.");
      }
    }

    // The ONLY place a plan is activated. `charged` tells the client whether we billed now or started/continued a trial.
    let charged = false;
    // A card-required signup is `blocked` meaning "no card yet", NOT "trial spent" — treating it as spent billed full price
    // on day one. Keyed on cardConfirmedAt, not status: Stripe cancels an abandoned unpaid trial, landing it on "canceled".
    const firstCardForCardRequired = profile.cardRequiredAtSignup && !profile.cardConfirmedAt;
    // `activateNow` (buying mid-trial) and `firstCardForCardRequired` must both force entry regardless of status: this
    // block is the only writer of cardConfirmedAt, and a walled account can be "trialing" with no card (suspend → reactivate).
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
        // End the Stripe trial now (bills the card), then activate. No second free trial.
        if (!profile.stripeSubscriptionId) throw badRequest("No subscription to activate");
        // Bill the card just entered, not the customer default — after a decline that default IS the refused card.
        try {
          await setSubscriptionDefaultPaymentMethod(profile.stripeSubscriptionId, paymentMethodId);
        } catch {
          /* best-effort — a single-card customer is already pointing at the right one */
        }
        // errorIfIncomplete keeps a decline atomic (still trialing). Dropping to past_due used to make the retry open a SECOND subscription.
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
            // Only writer of cardConfirmedAt (the card wall's key). Recorded once, for the FIRST card.
            ...(profile.cardConfirmedAt ? {} : { cardConfirmedAt: new Date() }),
          },
        });
        // Coupon is now redeemed. Must run BEFORE the minute grant so bonus minutes are live for the allowance calc.
        await activateRedemption(userId, profile.stripeSubscriptionId);
        await applyActivePlanMinutes(userId, {
          includedMinutes: await effectiveIncludedMinutes(userId, plan?.includedMinutes ?? 0),
          periodEnd,
          resetUsage: true,
        });
        // This charge is the coupon's first cycle. Keyed on its invoice so a same-day renewal counts as a separate cycle.
        const firstCycleInvoice = await getLatestPaidInvoice(profile.stripeSubscriptionId);
        await consumeCycle(
          userId,
          profile.stripeSubscriptionId,
          periodEnd,
          firstCycleInvoice?.id ?? null,
        );
        // Book the charge now — reseller commission and the ledger row that credits the brand wallet.
        // The invoice webhook does the same in production but never reaches local dev; both are idempotent on invoice id.
        if (firstCycleInvoice) {
          await accrueCommissionForInvoice({
            invoiceId: firstCycleInvoice.id,
            customerId: firstCycleInvoice.customerId,
            amountPaidCents: firstCycleInvoice.amountPaidCents,
          });
          await recordPaidInvoice({
            invoiceId: firstCycleInvoice.id,
            customerId: firstCycleInvoice.customerId,
            amountPaidCents: firstCycleInvoice.amountPaidCents,
            priceId: firstCycleInvoice.priceId,
            source: "go_live",
          });
        }
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
        // Continue the SAME trial (usage carries over). For a card-required signup the trial begins here, so snapshot the
        // allowance now. Usage is deliberately not reset — a grandfathered user must never get a fresh allowance.
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
        // Activate the coupon even though nothing was charged: left pending, the sweep bins it and the attached
        // multi-cycle discount runs forever with nothing counting. cyclesUsed stays 0 until a real charge.
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

/** Applies one Stripe event (brand context already set). Never throws for a business reason — Stripe retries failures forever, so leave it for the next event or the sweep. */
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
    // Profiles match on subscription OR customer id, so a currency switch's old-subscription deleted event would
    // mark a just-paid account "canceled". Only the subscription the profile holds may report its own death.
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
      // A card-required account without a confirmed card still owns a Stripe trial subscription that reports
      // "trialing". Mirroring that would hand out the free trial for picking a plan and closing the tab.
      const awaitingFirstCard = profile.cardRequiredAtSignup && !profile.cardConfirmedAt;
      const status =
        awaitingFirstCard && rawStatus !== "canceled" ? profile.subscriptionStatus : rawStatus;
      const entitled = status === "trialing" || status === "active";
      // Mirror Stripe's cancel flag: a portal cancel only touches Stripe, and a stale local autoRenew would let
      // the exhausted-minutes early renewal charge a card the user cancelled.
      const autoRenew = entitled ? !sub.cancel_at_period_end : false;

      // A pending downgrade lands once the period rolls past its date: promote the scheduled plan.
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
        // On trial→active, carry trial OVERAGE into the paid cycle (it lives in the trial counter).
        const trialAllocSec = (profile.trialMinutesAllocated ?? 0) * 60;
        const trialOverageSec =
          profile.subscriptionStatus === "trialing" && trialAllocSec > 0
            ? Math.max(0, profile.trialSecondsUsed - trialAllocSec)
            : 0;
        await applyActivePlanMinutes(profile.userId, {
          includedMinutes: await effectiveIncludedMinutes(profile.userId, effectivePlanMinutes),
          periodEnd: newPeriodEnd,
          // Only a real transition INTO active resets usage — this event also fires for toggles/price swaps that
          // change nothing. A real renewal still resets via the period-end advance.
          resetUsage: !wasActive,
          ...(trialOverageSec > 0 ? { carryOverSeconds: trialOverageSec } : {}),
        });
        // Count a coupon cycle, keyed on the latest PAID invoice: no-renewal events carry an already-counted invoice
        // and are ignored; a real renewal brings a new one even on the same day.
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
    // Ledger the payment split platform/brand and credit the brand wallet. The line's Price says whether this is the brand's Price at all.
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
    // Refund undoes the brand share proportionally. amount_refunded is cumulative, so a replayed event books nothing new.
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
      // Place the event in its brand first; unplaceable ones are parked for the super admin, never dropped. Stripe gets "received" either way.
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
      // Back to the customer's own origin. Stripe takes this per session, so a tenant needs no Stripe config of its own.
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
    // Sync portal changes first, forced past the throttle — users land here straight from the portal.
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

/** Toggle auto-renew (Stripe cancel_at_period_end). Off = ends at period end, then frozen until a plan is picked. Mirrored to Stripe. */
router.post(
  "/auto-renew",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const userId = req.user!.sub;
    const profile = await (await requestTenant(req)).profile.findUnique({ where: { userId } });
    if (!profile?.stripeSubscriptionId)
      throw badRequest("You don't have an active subscription to change.");

    // Stripe blocks cancel changes on scheduled subs, so a pending downgrade must be released — and our mirror of it
    // dropped, or the UI keeps promising a switch Stripe no longer has.
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

/** Renew the current plan NOW (minutes ran out or past_due). Charges a full period, resets minutes, re-enables auto-renew. Never restarts a trial. */
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
    // No confirmed card = nothing to renew. Without this, endTrialNow fails and the catch persists "past_due", which once opened the dashboard.
    if (profile.cardRequiredAtSignup && !profile.cardConfirmedAt)
      throw badRequest("Add your card to start your plan.");

    // If Stripe already canceled it (auto-renew off, period lapsed), create a fresh one on the same plan.
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

/** What's actually been paid toward the CURRENT cycle (undefined if unknown): the invoice's amount_paid plus mid-cycle
 *  upgrade deltas, which are standalone invoices — missing them under-credits anyone upgrading twice in a cycle. */
async function paidThisCycleCents(
  userId: string,
  subscriptionId: string,
): Promise<number | undefined> {
  const invoice = await getLatestPaidInvoice(subscriptionId).catch(() => null);
  // No paid invoice: "unknown", not "zero", so the caller falls back to the plan price.
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

  // Stripe won't swap in a price of another currency. Refused HERE so the preview stops too — it used to fail at the
  // swap AFTER the charge, and $20 AUD vs $20 USD compared as "same price".
  if (target.currency !== current.currency) {
    throw badRequest(
      `${target.displayName} is priced in ${target.currency.toUpperCase()} and your subscription bills in ${current.currency.toUpperCase()}. A subscription can't change currency — please contact support to move to this plan.`,
    );
  }

  // Transfer departments must fit the TARGET plan; refused in the shared loader so the preview explains it before
  // any charge. We never trim departments for them — which to lose is their call.
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

  // Price as actually billed (base + brand addon where the brand's Price applies) so proration matches Stripe's invoices. Mutated in place.
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

// Cross-currency plan switch: Stripe fixes currency per customer, so this needs a NEW customer + subscription with a
// re-entered card. Two untransacted Stripe writes, so ORDER is the design: start (old stays LIVE) → confirm → only then cancel the old.

/** Drop a half-finished switch. Best-effort — Stripe expires unpaid incomplete subscriptions after ~23h anyway. */
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

/** Begin a currency switch: new customer + unpaid subscription, returns a PaymentIntent secret. Changes nothing about the current plan. */
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
    // This flow charges immediately, so mid-trial it would burn their free days. /subscribe handles a trialing currency change.
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
      // Fresh subscription, not a swap — Stripe can't credit unused time across currencies.
      losesRemainingTime: true,
      currentPlan: { name: current.displayName, currency: current.currency },
    });
  }),
);

/** Finish a currency switch. Verifies with Stripe that the new subscription is paid BEFORE cancelling the old — the client saying so is not evidence. */
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

    // Cancel the old one only AFTER the profile points at the new: cancelling first raced the deleted webhook (which
    // flipped the fresh subscription to "canceled"), and a failure here means brief double billing (refundable), not no service.
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

    // Release a pending downgrade first — a scheduled subscription can't be price-swapped.
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

    // Upgrade (or same-price switch): COLLECT FIRST, then apply. Swap-first left a declined customer on the upgraded price in Stripe.
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
      // A same-price switch charges nothing, so this is reached with charged === 0 too — don't promise a refund that never existed.
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
    // Same billing date, so force the usage reset (they paid for a fresh allowance). Coupon BONUS MINUTES are deliberately
    // NOT re-added: they're per cycle and an upgrade isn't one — re-adding would let a customer farm them by upgrading repeatedly.
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
