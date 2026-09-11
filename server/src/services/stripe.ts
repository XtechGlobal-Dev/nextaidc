import Stripe from "stripe";
import { notImplemented } from "../lib/http.js";
import { env } from "../env.js";

// Stripe is configured via the server environment only (STRIPE_SECRET_KEY /
// STRIPE_WEBHOOK_SECRET) — deliberately not through the admin Settings UI/DB.

/** Whose a Stripe customer is. Stripe stays one account — the platform's —
 *  so every customer object carries the brand and account it belongs to. */
export interface StripeCustomerOwner {
  brandId: string | null | undefined;
  userId: string;
}

function ownerMetadata(owner: StripeCustomerOwner | null | undefined): Record<string, string> {
  return owner?.brandId ? { brandId: owner.brandId, userId: owner.userId } : {};
}

/** The Stripe webhook signing secret from the environment ("" when unset). */
export function stripeWebhookSecret(): string {
  return env.STRIPE_WEBHOOK_SECRET;
}

let client: Stripe | null = null;
let clientKey = "";
export function stripe(): Stripe {
  // Trim defensively: a stray trailing newline/space in the env value (a common
  // copy-paste artifact in hosting dashboards) corrupts the Authorization header
  // and surfaces as a StripeConnectionError, not an obvious auth error.
  const key = env.STRIPE_SECRET_KEY.trim();
  if (!key) throw notImplemented("Stripe is not configured (set STRIPE_SECRET_KEY in the server environment)");
  // Rebuild the client if the key changed at runtime.
  if (!client || clientKey !== key) {
    client = new Stripe(key);
    clientKey = key;
  }
  return client;
}

/** Verify + parse a Stripe webhook from the raw request body. */
export function constructEvent(rawBody: Buffer, signature: string): Stripe.Event {
  return stripe().webhooks.constructEvent(rawBody, signature, stripeWebhookSecret());
}

/**
 * Ensure a subscription can be charged OFF-SESSION by pointing it (and the
 * customer's invoice default) at the saved card when no default is set yet.
 *
 * A trial subscription is created via a SetupIntent and never takes a payment
 * while trialing, so Stripe often leaves `subscription.default_payment_method`
 * null throughout the trial. An immediate renewal / trial-end charge
 * (`renewSubscriptionNow`, `endTrialNow`) then has no card to bill and Stripe
 * fails the invoice as "incomplete" — surfacing as "we couldn't charge your
 * saved card" even though the card is perfectly valid. Setting the default here
 * makes the off-session charge succeed. Best-effort + idempotent: a no-op when a
 * default already exists or no card is on file (callers handle the empty case).
 */
export async function ensureSubscriptionDefaultPaymentMethod(subscriptionId: string): Promise<void> {
  const s = stripe();
  const sub = await s.subscriptions.retrieve(subscriptionId);
  if (sub.default_payment_method) return; // already chargeable
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
  if (!customerId) return;
  const pms = await s.paymentMethods.list({ customer: customerId, type: "card", limit: 1 });
  const pm = pms.data[0]?.id;
  if (!pm) return; // no card — the charge call surfaces the real "no card" error
  await s.subscriptions.update(subscriptionId, { default_payment_method: pm });
  // Also make it the customer's invoice default so any later charge finds it too.
  await s.customers
    .update(customerId, { invoice_settings: { default_payment_method: pm } })
    .catch(() => {});
}

/**
 * Force a specific card to be the default for a subscription (and the customer's
 * invoices), so the next charge bills THAT card.
 *
 * Distinct from `ensureSubscriptionDefaultPaymentMethod`, which deliberately
 * leaves an existing default alone. That is wrong for a retry: after a decline
 * the existing default IS the refused card, so charging again just fails the same
 * way and the customer can never recover by adding a working one.
 */
export async function setSubscriptionDefaultPaymentMethod(
  subscriptionId: string,
  paymentMethodId: string,
): Promise<void> {
  const s = stripe();
  const sub = await s.subscriptions.update(subscriptionId, {
    default_payment_method: paymentMethodId,
  });
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
  if (!customerId) return;
  await s.customers
    .update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } })
    .catch(() => {});
}

/**
 * End a subscription's trial immediately — charges the saved card and moves it to
 * active.
 *
 * With `errorIfIncomplete`, the update is ATOMIC: if the card is declined or needs
 * authentication (3DS off-session), Stripe throws AND leaves the subscription
 * trialing (rolled back) rather than ending the trial and dropping it to past_due.
 * The default (no flag) keeps the legacy fire-and-settle behaviour for the reconcile
 * / renew paths, where the trial is already over so there's nothing to preserve.
 */
export async function endTrialNow(
  subscriptionId: string,
  opts: { errorIfIncomplete?: boolean } = {},
): Promise<void> {
  // Make sure the saved card is the subscription default before the trial-end
  // charge fires, or Stripe would fail the first invoice for lack of a card.
  await ensureSubscriptionDefaultPaymentMethod(subscriptionId);
  await stripe().subscriptions.update(subscriptionId, {
    trial_end: "now",
    ...(opts.errorIfIncomplete ? { payment_behavior: "error_if_incomplete" } : {}),
  });
}

/** Fetch a subscription's live status + current period end from Stripe. */
export async function getSubscription(subscriptionId: string): Promise<{
  status: string;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  priceId: string | null;
  itemId: string | null;
  scheduleId: string | null;
}> {
  const sub = await stripe().subscriptions.retrieve(subscriptionId);
  const item = sub.items?.data?.[0];
  const priceId = item ? (typeof item.price === "string" ? item.price : item.price.id) : null;
  const scheduleId = typeof sub.schedule === "string" ? sub.schedule : sub.schedule?.id ?? null;
  return {
    status: sub.status,
    currentPeriodEnd: sub.current_period_end ?? null,
    cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
    priceId,
    itemId: item?.id ?? null,
    scheduleId,
  };
}

/**
 * Switch a subscription to a new price IMMEDIATELY with no Stripe proration — we
 * compute our own minutes-based credit and charge the delta separately. Used for
 * upgrades (and trial users changing their post-trial plan). Returns the new
 * current_period_end.
 */
export async function swapSubscriptionPriceNow(
  subscriptionId: string,
  newPriceId: string,
): Promise<{ currentPeriodEnd: number | null }> {
  const sub = await stripe().subscriptions.retrieve(subscriptionId);
  const item = sub.items.data[0];
  const updated = await stripe().subscriptions.update(subscriptionId, {
    items: [{ id: item.id, price: newPriceId }],
    proration_behavior: "none",
    payment_behavior: "error_if_incomplete",
  });
  return { currentPeriodEnd: updated.current_period_end ?? null };
}

/**
 * Switch an IN-TRIAL subscription to a different plan price WITHOUT opening a
 * second subscription. Used by /subscribe when the user re-picks a plan during
 * signup (before saving a card): creating a fresh subscription each time would
 * orphan the previous one in Stripe and log a duplicate "trial started".
 *
 * No charge — the swap only decides which plan activates at trial end. Returns a
 * SetupIntent client secret so the signup card step still works: it reuses the
 * subscription's pending SetupIntent when the card isn't on file yet, otherwise
 * mints a standalone one.
 */
export async function switchTrialSubscriptionPlan(
  subscriptionId: string,
  newPriceId: string,
): Promise<{ subscriptionId: string; clientSecret: string | null; trialEnd: number | null }> {
  const s = stripe();
  const sub = await s.subscriptions.retrieve(subscriptionId, {
    expand: ["pending_setup_intent"],
  });
  const item = sub.items.data[0];
  const currentPriceId = typeof item.price === "string" ? item.price : item.price.id;

  // Same plan re-picked → nothing to swap; just hand back the setup intent below.
  if (currentPriceId !== newPriceId) {
    await s.subscriptions.update(subscriptionId, {
      items: [{ id: item.id, price: newPriceId }],
      proration_behavior: "none",
    });
  }

  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  let clientSecret = (sub.pending_setup_intent as Stripe.SetupIntent | null)?.client_secret ?? null;
  // Card already saved (no pending setup intent) → mint one so the "pay" step
  // always has a secret to confirm with.
  if (!clientSecret) {
    const si = await s.setupIntents.create({
      customer: customerId,
      payment_method_types: ["card"],
      usage: "off_session",
    });
    clientSecret = si.client_secret;
  }

  return { subscriptionId: sub.id, clientSecret, trialEnd: sub.trial_end ?? null };
}

/**
 * Create a fresh subscription that charges the customer's saved card RIGHT NOW
 * (no trial) — used to renew a plan whose previous subscription has ended/canceled.
 * Picks the customer's first saved card as the subscription default so the initial
 * invoice is paid immediately. `error_if_incomplete` throws on a declined card.
 */
export async function createImmediateSubscription(
  customerId: string,
  priceId: string,
): Promise<{ subscriptionId: string; currentPeriodEnd: number | null; active: boolean }> {
  const s = stripe();
  const pms = await s.paymentMethods.list({ customer: customerId, type: "card", limit: 1 });
  const pm = pms.data[0]?.id;
  if (!pm) throw new Error("no saved card on file");
  const sub = await s.subscriptions.create({
    customer: customerId,
    items: [{ price: priceId }],
    default_payment_method: pm,
    payment_behavior: "error_if_incomplete",
    payment_settings: { save_default_payment_method: "on_subscription" },
  });
  return {
    subscriptionId: sub.id,
    currentPeriodEnd: sub.current_period_end ?? null,
    active: sub.status === "active",
  };
}

/**
 * Open a paid subscription for a CURRENCY SWITCH, on a brand-new customer.
 *
 * A Stripe customer is permanently locked to the currency of its first invoice,
 * so an AUD customer can never hold a USD subscription — `subscriptions.create`
 * fails with "cannot combine currencies". The only route is a fresh customer,
 * which also means a fresh card: payment methods cannot be moved between
 * customers, so the caller must collect one.
 *
 * Returns `default_incomplete`, so nothing is charged until the client confirms
 * the returned PaymentIntent. That is what lets the caller keep the customer's
 * EXISTING subscription running until this one is genuinely paid — the whole
 * point, since cancel-then-create would strand them on a declined card.
 */
export async function createCurrencySwitchSubscription(opts: {
  email: string;
  name?: string;
  priceId: string;
  /** Whose customer this is — stamped on the Stripe object so a payment can
   *  always be placed in the right brand, even if our own index is lost. */
  owner?: StripeCustomerOwner | null;
}): Promise<{ customerId: string; subscriptionId: string; clientSecret: string | null }> {
  const s = stripe();
  const customer = await s.customers.create({
    email: opts.email,
    name: opts.name?.trim() || undefined,
    // Marked so an abandoned switch is identifiable in the dashboard rather than
    // looking like a duplicate account someone created by mistake.
    metadata: { purpose: "currency_switch", ...ownerMetadata(opts.owner) },
  });
  const sub = await s.subscriptions.create({
    customer: customer.id,
    items: [{ price: opts.priceId }],
    payment_behavior: "default_incomplete",
    payment_settings: {
      save_default_payment_method: "on_subscription",
      payment_method_types: ["card"],
    },
    expand: ["latest_invoice.payment_intent"],
  });

  const invoice = sub.latest_invoice as Stripe.Invoice | null;
  const intent = invoice?.payment_intent as Stripe.PaymentIntent | null;
  return {
    customerId: customer.id,
    subscriptionId: sub.id,
    clientSecret: intent?.client_secret ?? null,
  };
}

/**
 * Renew a subscription IMMEDIATELY by resetting its billing cycle anchor to now.
 * Used when a user burns through their included minutes before the period date:
 * Stripe invoices a fresh full period right away (no proration credit for the
 * unused old period), charges the saved card, and restarts the 30-day clock so
 * the next renewal is a full interval out. `error_if_incomplete` makes a declined
 * card throw so the caller can flip the user to past_due. Returns the new
 * current_period_end and whether the subscription is active after the charge.
 */
export async function renewSubscriptionNow(
  subscriptionId: string,
  opts: {
    /** Collapse concurrent AUTOMATIC renewals of the same cycle into one charge.
     *  Deliberately OFF for user-initiated retries: Stripe caches failed responses
     *  under the key too, so a customer who fixes their card and retries within
     *  24h would otherwise get the cached decline back instead of a real attempt. */
    dedupeConcurrent?: boolean;
  } = {},
): Promise<{ currentPeriodEnd: number | null; active: boolean; releasedScheduleId: string | null }> {
  // Point the subscription at the saved card first — a sub created from a trial
  // may have no default_payment_method, which makes the off-session renewal
  // charge fail with "incomplete" even on a valid card.
  await ensureSubscriptionDefaultPaymentMethod(subscriptionId);

  // Same restriction as `setSubscriptionAutoRenew`: a schedule-managed
  // subscription (pending downgrade) rejects a `billing_cycle_anchor` write, so
  // an early renewal would throw and drop the user to past_due — line frozen —
  // purely because they had a downgrade queued. Release the schedule first: the
  // user renews on their CURRENT plan and the queued change is dropped, since
  // the cycle boundary it was pinned to is the one being consumed right now.
  const sub = await stripe().subscriptions.retrieve(subscriptionId);
  const scheduleId = typeof sub.schedule === "string" ? sub.schedule : sub.schedule?.id ?? null;
  if (scheduleId) await releaseSchedule(scheduleId);

  // Idempotency key derived from the cycle being replaced, as a second line of
  // defence behind the caller's DB claim: if two requests still race here they
  // both read the SAME current_period_end, so Stripe collapses them into one
  // charge instead of billing the customer twice. A genuine later renewal has a
  // different period end → a different key → it charges normally.
  const updated = await stripe().subscriptions.update(
    subscriptionId,
    {
      billing_cycle_anchor: "now",
      proration_behavior: "none",
      payment_behavior: "error_if_incomplete",
    },
    opts.dedupeConcurrent
      ? { idempotencyKey: `renew:${subscriptionId}:${sub.current_period_end ?? 0}` }
      : {},
  );
  return {
    currentPeriodEnd: updated.current_period_end ?? null,
    active: updated.status === "active",
    releasedScheduleId: scheduleId,
  };
}

/**
 * Schedule a price change for the NEXT renewal (downgrade). The current price
 * stays active and billed until period end; the new price takes over after.
 * Returns the schedule id + when it takes effect. Implemented via Stripe
 * subscription schedules so billing flips atomically at the cycle boundary.
 */
export async function scheduleDowngrade(
  subscriptionId: string,
  newPriceId: string,
): Promise<{ scheduleId: string; effectiveAt: number | null }> {
  const sub = await stripe().subscriptions.retrieve(subscriptionId, { expand: ["discounts"] });
  const item = sub.items.data[0];
  const currentPriceId = typeof item.price === "string" ? item.price : item.price.id;

  // A live coupon MUST be restated on every phase we write. Stripe's rule for a
  // phase is "if `discounts` is not specified, inherit from the subscription's
  // CUSTOMER" — and our coupons sit on the subscription, not the customer. So
  // writing phases without it silently strips the discount the moment the
  // schedule takes over, and a customer with cycles left on their coupon quietly
  // starts paying full price. Nothing errors; the money just changes.
  const coupons: string[] = [];
  for (const d of sub.discounts ?? []) {
    if (typeof d === "string") continue; // unexpanded id — nothing to read
    const couponId = typeof d.coupon === "string" ? d.coupon : d.coupon?.id;
    if (couponId) coupons.push(couponId);
  }
  const discounts = coupons.map((coupon) => ({ coupon }));

  const schedule = await stripe().subscriptionSchedules.create({ from_subscription: subscriptionId });
  const phase0Start = schedule.phases[0]?.start_date;
  await stripe().subscriptionSchedules.update(schedule.id, {
    end_behavior: "release",
    phases: [
      {
        items: [{ price: currentPriceId, quantity: 1 }],
        start_date: phase0Start,
        end_date: sub.current_period_end,
        ...(discounts.length > 0 ? { discounts } : {}),
      },
      {
        // The downgraded phase carries it too: a coupon is a number of BILLING
        // CYCLES, not a plan, so cycles bought before the downgrade are still
        // owed on the cheaper plan. Our own counter retires it on schedule.
        items: [{ price: newPriceId, quantity: 1 }],
        ...(discounts.length > 0 ? { discounts } : {}),
      },
    ],
  });
  return { scheduleId: schedule.id, effectiveAt: sub.current_period_end ?? null };
}

/**
 * Rewrite the discount on a pending schedule's remaining phases.
 *
 * `scheduleDowngrade` bakes the coupon that was attached AT THE MOMENT it ran
 * into every phase, and nothing refreshes it afterwards. If the account's
 * discount changes in the meantime — replaced by an admin grant, or retired when
 * its cycles ran out — the schedule still re-applies the OLD coupon when it takes
 * over at the period boundary. The customer is then billed under a coupon our
 * records no longer consider live, while cycles are counted against a different
 * one: two coupons on one account, and a `forever` Stripe coupon never expires by
 * itself.
 *
 * `couponId` null clears the discount from the remaining phases.
 * Best-effort: a schedule that has already been released or completed is not an
 * error, it just means there is nothing left to correct.
 */
export async function setSchedulePhaseDiscounts(
  scheduleId: string,
  couponId: string | null,
): Promise<void> {
  const schedule = await stripe().subscriptionSchedules.retrieve(scheduleId);
  if (schedule.status === "released" || schedule.status === "canceled") return;
  // Only phases still in the future can be rewritten; Stripe rejects edits to a
  // phase that has already started.
  const now = Math.floor(Date.now() / 1000);
  const upcoming = (schedule.phases ?? []).filter((p) => (p.end_date ?? 0) > now);
  if (upcoming.length === 0) return;

  const phases: Stripe.SubscriptionScheduleUpdateParams.Phase[] = upcoming.map((p) => ({
    items: p.items.map((i) => ({
      price: typeof i.price === "string" ? i.price : i.price.id,
      quantity: i.quantity ?? 1,
    })),
    start_date: p.start_date,
    ...(p.end_date ? { end_date: p.end_date } : {}),
    // "" to clear, never [] — an empty array is dropped entirely by the
    // form encoder (see detachSubscriptionDiscount), which here would write a
    // phase with no `discounts` key and leave Stripe to fall back to its
    // "inherit from the customer" rule rather than stating the clear.
    discounts: couponId ? [{ coupon: couponId }] : "",
  }));
  await stripe().subscriptionSchedules.update(scheduleId, { phases });
}

/** Release a subscription schedule (cancel a pending downgrade). Best-effort. */
export async function releaseSchedule(scheduleId: string): Promise<void> {
  try {
    await stripe().subscriptionSchedules.release(scheduleId);
  } catch {
    /* best-effort — already released/expired */
  }
}

/**
 * Charge the customer's saved default card a ONE-TIME amount via a standalone
 * invoice (used for the upgrade delta and add-on purchases). Returns the invoice
 * id. Throws if the charge can't be collected so callers can surface the error.
 */
/**
 * The card a standalone invoice should charge: the customer's own invoice default
 * when set, otherwise their most recent saved card. Returns null when there is no
 * card at all, so the caller can let Stripe surface the real "no card" error.
 */
async function defaultCardFor(customerId: string): Promise<string | null> {
  const s = stripe();
  try {
    const customer = await s.customers.retrieve(customerId);
    if (!customer.deleted) {
      const def = customer.invoice_settings?.default_payment_method;
      const id = typeof def === "string" ? def : def?.id ?? null;
      if (id) return id;
    }
  } catch {
    /* fall through to the card list */
  }
  const pms = await s.paymentMethods.list({ customer: customerId, type: "card", limit: 1 });
  return pms.data[0]?.id ?? null;
}

export async function chargeOneTime(
  customerId: string,
  amountCents: number,
  description: string,
  currency = "usd",
): Promise<{ invoiceId: string; paid: boolean }> {
  if (amountCents <= 0) return { invoiceId: "", paid: true };
  const s = stripe();

  // Create the DRAFT invoice first, then attach the line item to it by id. A
  // customer-level invoice item (no `invoice`) is merely *pending*: if this
  // invoice never collects it, Stripe silently sweeps it onto the customer's
  // NEXT subscription invoice. That is how a $6 upgrade delta resurfaced a month
  // later as part of a bigger renewal bill the customer never agreed to.
  // Resolve the card to charge and pin it ON the invoice. A standalone invoice
  // bills the CUSTOMER's `invoice_settings.default_payment_method` — NOT the
  // subscription's. Those are different fields, and
  // `ensureSubscriptionDefaultPaymentMethod` returns early when the subscription
  // already has a card, so the customer-level default is often never set. Without
  // this the invoice has no card to charge and `pay` fails with "no attached
  // payment method" even though the customer plainly has a working card on file.
  const paymentMethodId = await defaultCardFor(customerId);

  const draft = await s.invoices.create({
    customer: customerId,
    auto_advance: false, // we drive finalize + pay ourselves, synchronously
    collection_method: "charge_automatically",
    ...(paymentMethodId ? { default_payment_method: paymentMethodId } : {}),
    description,
  });
  await s.invoiceItems.create({
    customer: customerId,
    invoice: draft.id,
    amount: amountCents,
    currency,
    description,
  });

  try {
    const finalized = await s.invoices.finalizeInvoice(draft.id);
    // `finalizeInvoice` does NOT take the money — with auto_advance it is collected
    // asynchronously, so reading `status` here returned "open" and made every
    // upgrade look like a failed charge. `pay` actually charges the saved card and
    // resolves with the settled invoice.
    const paidInvoice =
      finalized.status === "paid" ? finalized : await s.invoices.pay(draft.id);
    return { invoiceId: paidInvoice.id, paid: paidInvoice.status === "paid" };
  } catch (e) {
    // Collection failed (declined card, no card on file…). VOID the invoice so the
    // amount cannot be picked up by a later invoice — an uncollected charge must
    // disappear, never reappear unannounced on the next renewal.
    await s.invoices.voidInvoice(draft.id).catch(async () => {
      await s.invoices.del(draft.id).catch(() => {}); // still a draft → delete instead
    });
    console.error(
      `[billing] one-time charge failed for customer ${customerId} (${amountCents} ${currency}):`,
      e instanceof Error ? e.message : e,
    );
    return { invoiceId: draft.id, paid: false };
  }
}

/** Read a payment method's card fingerprint (stable per physical card across
 *  customers) and its owning customer id. Used to stop the same card opening a
 *  second trial account. Fingerprint is null for non-card methods. */
export async function getCardFingerprint(paymentMethodId: string): Promise<{
  fingerprint: string | null;
  customerId: string | null;
}> {
  const pm = await stripe().paymentMethods.retrieve(paymentMethodId);
  const customerId = typeof pm.customer === "string" ? pm.customer : pm.customer?.id ?? null;
  const fingerprint = pm.card?.fingerprint ?? null;
  if (!fingerprint) {
    console.warn(`[billing] no card fingerprint for pm=${paymentMethodId} (type=${pm.type}) — card dedup skipped`);
  }
  return { fingerprint, customerId };
}

/** Attach a payment method to a customer. Normally the SetupIntent does this on
 *  success, so this is the repair path for a method that reached us unattached —
 *  see /confirm-card, where "a card is on file" is a security decision, not a
 *  formality. Throws if Stripe refuses (unusable or already someone else's). */
export async function attachPaymentMethod(
  paymentMethodId: string,
  customerId: string,
): Promise<void> {
  await stripe().paymentMethods.attach(paymentMethodId, { customer: customerId });
}

/** Latest PAID invoice for a subscription (id + amount + customer + when), or
 *  null. Used to accrue reseller commission in dev where the invoice webhook
 *  doesn't reach us, and to establish what a customer actually paid for the
 *  cycle a plan change is replacing — `amount_paid` is after any discount,
 *  which is exactly what proration credit must be a share of. */
export async function getLatestPaidInvoice(subscriptionId: string): Promise<{
  id: string;
  amountPaidCents: number;
  customerId: string;
  createdAt: Date;
  /** The Price the first line billed — how a brand's addon share is attributed. */
  priceId: string | null;
} | null> {
  const invoices = await stripe().invoices.list({ subscription: subscriptionId, status: "paid", limit: 1 });
  const inv = invoices.data[0];
  if (!inv?.id) return null;
  const customerId = typeof inv.customer === "string" ? inv.customer : inv.customer?.id ?? "";
  // Older API versions expose `line.price`, newer ones `line.pricing.price_details`.
  const line = inv.lines?.data?.[0] as
    | { price?: { id?: string } | null; pricing?: { price_details?: { price?: string } } }
    | undefined;
  return {
    id: inv.id,
    amountPaidCents: inv.amount_paid,
    customerId,
    createdAt: new Date((inv.created ?? 0) * 1000),
    priceId: line?.price?.id ?? line?.pricing?.price_details?.price ?? null,
  };
}

/** First saved card fingerprint for a customer (null if none) — for backfilling
 *  existing accounts created before card-dedup was in place. */
export async function getCustomerCardFingerprint(customerId: string): Promise<string | null> {
  const pms = await stripe().paymentMethods.list({ customer: customerId, type: "card", limit: 1 });
  return pms.data[0]?.card?.fingerprint ?? null;
}

/** Detach a saved card from its customer (e.g. a rejected duplicate). Best-effort. */
export async function detachPaymentMethod(paymentMethodId: string): Promise<void> {
  try {
    await stripe().paymentMethods.detach(paymentMethodId);
  } catch {
    /* best-effort */
  }
}

/**
 * Toggle auto-renew on a subscription. `enabled=false` sets
 * `cancel_at_period_end` so the plan (or trial) ends at the current period with
 * no further charge; `true` clears it so it renews + charges as normal.
 *
 * A subscription attached to a subscription schedule (i.e. a pending downgrade)
 * rejects any direct cancelation-behaviour update — Stripe answers "The
 * subscription is managed by the subscription schedule `sub_sched_…`, and
 * updating any cancelation behavior directly is not allowed." So we release the
 * schedule first. Releasing detaches it and leaves the subscription exactly as
 * it is (same price, same period), so the *current* plan is untouched; only the
 * queued next-cycle price change goes away — which is moot anyway once there is
 * no next cycle. Returns the released schedule id so the caller can clear the
 * pending-downgrade bookkeeping it mirrors in our own DB.
 */
export async function setSubscriptionAutoRenew(
  subscriptionId: string,
  enabled: boolean,
): Promise<{ releasedScheduleId: string | null }> {
  const sub = await stripe().subscriptions.retrieve(subscriptionId);
  // Already in the desired state → do nothing. Keeps no-op toggles from hitting
  // the schedule restriction at all.
  if ((sub.cancel_at_period_end ?? false) === !enabled) return { releasedScheduleId: null };

  const scheduleId = typeof sub.schedule === "string" ? sub.schedule : sub.schedule?.id ?? null;
  if (scheduleId) await releaseSchedule(scheduleId);

  await stripe().subscriptions.update(subscriptionId, { cancel_at_period_end: !enabled });
  return { releasedScheduleId: scheduleId };
}

/**
 * Read the live auto-renew state of a subscription from Stripe. Returns `false`
 * when the subscription is set to cancel at period end (or is gone/canceled).
 * Used as a safety net before an early minutes-exhausted renewal so a cancel
 * done in the hosted portal is honoured even if its webhook hasn't landed yet.
 */
export async function getSubscriptionAutoRenew(subscriptionId: string): Promise<boolean> {
  const sub = await stripe().subscriptions.retrieve(subscriptionId);
  const alive = sub.status === "active" || sub.status === "trialing";
  return alive && !sub.cancel_at_period_end;
}

/** Cancel a subscription immediately. Best-effort — never throws. */
export async function cancelSubscription(subscriptionId: string): Promise<void> {
  try {
    await stripe().subscriptions.cancel(subscriptionId);
  } catch {
    /* best-effort */
  }
}

/* ------------------------------------------------------------------ *
 *  Product / price sync for admin-created plans & add-ons.
 *  Stripe prices are immutable, so a price change = a new price + the
 *  old one archived. Products are archived (not deleted) on removal.
 * ------------------------------------------------------------------ */
export type StripeInterval = "week" | "month" | "year";

/** True when a Stripe secret key is configured in the environment. */
export function isStripeConfigured(): boolean {
  return env.STRIPE_SECRET_KEY.trim().length > 0;
}

/** Create a product + recurring price. Returns the new ids. */
export async function createStripeProductPrice(opts: {
  name: string;
  description?: string;
  amountCents: number;
  currency: string;
  interval: StripeInterval;
  /** Units per cycle (Stripe interval_count): 3 = quarterly, 12 = annual.
   *  Omitted or 1 = a plain one-unit cycle. */
  intervalCount?: number;
}): Promise<{ productId: string; priceId: string }> {
  const s = stripe();
  const product = await s.products.create({
    name: opts.name,
    description: opts.description?.trim() || undefined,
  });
  const price = await s.prices.create({
    product: product.id,
    unit_amount: opts.amountCents,
    currency: opts.currency,
    recurring: {
      interval: opts.interval,
      // Sent only when it isn't 1: Stripe defaults to 1, and omitting it keeps
      // existing monthly prices byte-identical to what we created before.
      ...(opts.intervalCount && opts.intervalCount > 1
        ? { interval_count: opts.intervalCount }
        : {}),
    },
  });
  return { productId: product.id, priceId: price.id };
}

/** Update a product's name/description/active flag. */
export async function updateStripeProduct(
  productId: string,
  opts: { name?: string; description?: string; active?: boolean },
): Promise<void> {
  const s = stripe();
  await s.products.update(productId, {
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.description !== undefined ? { description: opts.description.trim() || undefined } : {}),
    ...(opts.active !== undefined ? { active: opts.active } : {}),
  });
}

/** Create a new recurring price under an existing product (price changes). */
export async function createStripePrice(
  productId: string,
  amountCents: number,
  currency: string,
  interval: StripeInterval,
  intervalCount = 1,
): Promise<string> {
  const s = stripe();
  const price = await s.prices.create({
    product: productId,
    unit_amount: amountCents,
    currency,
    recurring: {
      interval,
      ...(intervalCount > 1 ? { interval_count: intervalCount } : {}),
    },
  });
  return price.id;
}

/** Archive (deactivate) a price — Stripe doesn't allow hard-deleting used prices. */
export async function archiveStripePrice(priceId: string): Promise<void> {
  await stripe().prices.update(priceId, { active: false });
}

/** Archive (deactivate) a product on removal. */
export async function archiveStripeProduct(productId: string): Promise<void> {
  await stripe().products.update(productId, { active: false });
}

/* ------------------------------------------------------------------ *
 *  Coupons.
 *
 *  Our `Coupon` rows are mirrored to Stripe coupon objects, which do the
 *  arithmetic on subscription invoices (so hosted invoices, the customer
 *  portal and Stripe reporting all show the discount without us
 *  reimplementing it) — the same mirror pattern as plans → products/prices.
 *
 *  Duration deliberately only ever uses "once" or "forever", never Stripe's
 *  `duration_in_months`:
 *    • once    — a single-cycle coupon. Stripe drops it after the first
 *                invoice itself, so there is nothing for us to leak.
 *    • forever — a multi-cycle coupon. WE count billing cycles and detach it
 *                when the budget is spent, because Stripe's month-based
 *                duration is wrong here: `renewActivePlanIfExhausted` renews
 *                early whenever a user burns their minutes, so a heavy user
 *                can consume several cycles inside one calendar month and
 *                Stripe would discount every one of them.
 * ------------------------------------------------------------------ */
export type StripeCouponDuration = "once" | "forever";

/** Create a percentage-off Stripe coupon. Returns the new coupon id. */
export async function createStripeCoupon(opts: {
  name: string;
  percentOff: number;
  duration: StripeCouponDuration;
}): Promise<string> {
  const coupon = await stripe().coupons.create({
    name: opts.name,
    percent_off: opts.percentOff,
    duration: opts.duration,
  });
  return coupon.id;
}

/** Delete a Stripe coupon. Best-effort — deleting one leaves discounts already
 *  applied to subscriptions intact, which is why our own detach path exists. */
export async function deleteStripeCoupon(couponId: string): Promise<void> {
  try {
    await stripe().coupons.del(couponId);
  } catch {
    /* best-effort — already gone / never created */
  }
}

/**
 * Apply a coupon to a subscription as its discount.
 *
 * Uses the modern `discounts` array rather than the deprecated top-level
 * `coupon` field. Passing a single-element array also means attaching replaces
 * whatever discount was there — we only ever allow one live discount per
 * account, so that is exactly the semantics we want.
 */
export async function attachSubscriptionDiscount(
  subscriptionId: string,
  couponId: string,
): Promise<void> {
  await stripe().subscriptions.update(subscriptionId, {
    discounts: [{ coupon: couponId }],
  });
}

/**
 * Remove whatever discount a subscription currently carries.
 *
 * The clear MUST be the empty STRING, not an empty array. Stripe's API is
 * form-encoded, and stripe-node runs the params through `qs.stringify` — which
 * emits nothing at all for an empty array:
 *
 *   qs.stringify({ discounts: [] })  →  ""            (no parameter is sent)
 *   qs.stringify({ discounts: "" })  →  "discounts="  (Stripe clears it)
 *
 * So `discounts: []` posted an EMPTY body: a successful, silent no-op update
 * that left the coupon exactly where it was. That is how a 2-cycle coupon went
 * on discounting every invoice forever — our own bookkeeping retired the
 * redemption on time (`cyclesUsed` hit the budget, status `exhausted`), this
 * call reported success, and Stripe never heard about it. Nothing threw, so
 * neither the caller's catch nor `healDiscountDrift` — which clears through
 * this same function — could tell anything had gone wrong.
 *
 * Stripe's own typing says as much: the param is `Emptyable<Array<Discount>>`,
 * i.e. `"" | Discount[]`, and "" is the documented way to remove.
 */
export async function detachSubscriptionDiscount(subscriptionId: string): Promise<void> {
  await stripe().subscriptions.update(subscriptionId, { discounts: "" });
}

/**
 * The coupon id currently discounting a subscription, or null. Used by the
 * reconcile safety net to spot a discount that outlived its cycle budget (e.g.
 * a missed webhook meant we never detached it) and heal it.
 *
 * Returns null rather than throwing when the subscription is gone, so a caller
 * that is merely checking for drift is never broken by a deleted subscription.
 */
export async function getSubscriptionDiscountCouponId(
  subscriptionId: string,
): Promise<string | null> {
  try {
    const sub = await stripe().subscriptions.retrieve(subscriptionId, {
      expand: ["discounts"],
    });
    for (const d of sub.discounts ?? []) {
      // Unexpanded entries are bare ids; we asked for expansion, but tolerate both.
      if (typeof d === "string") continue;
      const couponId = typeof d.coupon === "string" ? d.coupon : d.coupon?.id;
      if (couponId) return couponId;
    }
    return null;
  } catch {
    return null;
  }
}

/** Fetch a customer's recent invoices for display. */
export async function getCustomerInvoices(
  customerId: string,
  limit = 12,
): Promise<Array<{
  id: string;
  number: string | null;
  status: string | null;
  amountDue: number;
  amountPaid: number;
  currency: string;
  created: number;
  hostedInvoiceUrl: string | null;
  pdfUrl: string | null;
}>> {
  const s = stripe();
  const list = await s.invoices.list({ customer: customerId, limit });
  // Stripe auto-creates $0 invoices for trial starts (`subscription_create`) and
  // zero-net plan swaps (`subscription_update`). They're bookkeeping noise — showing
  // them makes a paid plan look like a wall of "$0 Paid" rows — so only surface
  // invoices where money actually moved (or is genuinely owed on an open invoice).
  return list.data
    .filter((inv) => inv.total !== 0 || inv.amount_paid !== 0 || inv.amount_due !== 0)
    .map((inv) => ({
    id: inv.id,
    number: inv.number,
    status: inv.status,
    amountDue: inv.amount_due,
    amountPaid: inv.amount_paid,
    currency: inv.currency,
    created: inv.created,
    hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
    pdfUrl: inv.invoice_pdf ?? null,
  }));
}

/**
 * Pick the Stripe customer to attach a new subscription to, respecting Stripe's
 * per-customer currency lock. Returns the existing customer when it's safe to
 * reuse, otherwise a freshly-created one. A customer's `currency` is set by
 * Stripe on its first subscription/invoice and can never change; once locked,
 * a subscription in any other currency is rejected.
 */
async function resolveSubscriptionCustomer(
  s: Stripe,
  existingCustomerId: string | null,
  targetCurrency: string | undefined,
  createFresh: () => Promise<string>,
): Promise<string> {
  if (!existingCustomerId) return createFresh();
  const want = targetCurrency?.toLowerCase();
  if (!want) return existingCustomerId; // no plan currency to check against — reuse
  try {
    const existing = await s.customers.retrieve(existingCustomerId);
    if ((existing as Stripe.DeletedCustomer).deleted) return createFresh();
    const locked = (existing as Stripe.Customer).currency?.toLowerCase();
    // Not yet locked (never charged) → reuse. Locked to the same currency → reuse.
    // Locked to a different currency → must use a new customer.
    if (locked && locked !== want) return createFresh();
    return existingCustomerId;
  } catch {
    // Old customer unreachable (deleted upstream, key rotated…) → start clean.
    return createFresh();
  }
}

/* ------------------------------------------------------------------ *
 *  Trial subscription (card required, in-app via Elements).
 *  Creates a customer + a subscription with a trial. Because a trial
 *  has no immediate charge, Stripe returns a pending SetupIntent whose
 *  client_secret the frontend uses (Stripe Elements) to save the card.
 *  When the trial ends Stripe auto-charges the saved card.
 * ------------------------------------------------------------------ */
export async function createTrialSubscription(opts: {
  email: string;
  name?: string;
  priceIds: string[]; // plan price first, then any add-on prices
  trialDays: number;
  existingCustomerId?: string | null;
  /** Plan currency (e.g. "usd"/"aud"). Used to detect a currency-locked customer. */
  currency?: string;
  /** Stripe coupon to discount this subscription from its very first invoice.
   *  Applied at creation rather than in a follow-up update because the checkout
   *  charge (`endTrialNow` from /confirm-card) bills that first invoice — a
   *  discount attached afterwards would arrive too late to reduce it. */
  couponId?: string | null;
  /** Whose customer this is — stamped on a newly created Stripe customer so a
   *  payment can always be placed in the right brand, even if our own index
   *  is lost. */
  owner?: StripeCustomerOwner | null;
}): Promise<{
  customerId: string;
  subscriptionId: string;
  clientSecret: string | null;
  trialEnd: number | null;
  itemsByPrice: Record<string, string>; // priceId -> subscription item id
}> {
  const s = stripe();
  const newCustomer = () =>
    s.customers
      .create({ email: opts.email, name: opts.name?.trim() || undefined, metadata: ownerMetadata(opts.owner) })
      .then((c) => c.id);

  // A Stripe customer is permanently locked to the currency of its first
  // subscription/invoice. If we switched the plan currency (e.g. USD → AUD),
  // reusing the old customer makes subscriptions.create fail with "You cannot
  // combine currencies on a single customer". Detect the mismatch and mint a
  // fresh customer so the new-currency subscription can be created.
  const customerId = await resolveSubscriptionCustomer(
    s,
    opts.existingCustomerId ?? null,
    opts.currency,
    newCustomer,
  );

  const sub = await s.subscriptions.create({
    customer: customerId,
    items: opts.priceIds.map((price) => ({ price })),
    ...(opts.couponId ? { discounts: [{ coupon: opts.couponId }] } : {}),
    trial_period_days: opts.trialDays,
    payment_behavior: "default_incomplete",
    // Card only — don't surface Klarna/pay-later etc. from the Stripe dashboard's
    // automatic payment methods. Forces the auto-generated SetupIntent to card,
    // which flows through to the frontend Payment Element.
    payment_settings: {
      save_default_payment_method: "on_subscription",
      payment_method_types: ["card"],
    },
    trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
    expand: ["pending_setup_intent"],
  });

  const itemsByPrice: Record<string, string> = {};
  for (const item of sub.items.data) {
    const priceId = typeof item.price === "string" ? item.price : item.price.id;
    itemsByPrice[priceId] = item.id;
  }

  const setupIntent = sub.pending_setup_intent as Stripe.SetupIntent | null;
  return {
    customerId,
    subscriptionId: sub.id,
    clientSecret: setupIntent?.client_secret ?? null,
    trialEnd: sub.trial_end ?? null,
    itemsByPrice,
  };
}
