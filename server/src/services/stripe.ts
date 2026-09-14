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
  // Trim: a stray newline in the env value corrupts the Authorization header and
  // shows up as a StripeConnectionError, not an auth error.
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

/** Points a subscription at the saved card when it has no default. Trial subs often have none (SetupIntent, no payment yet), so off-session charges failed as "incomplete" on a perfectly valid card. No-op if a default exists. */
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

/** Forces THIS card as the subscription + invoice default. Unlike `ensure...`, overwrites an existing default — after a decline the existing default IS the refused card. */
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

/** Ends the trial now and charges the card. With `errorIfIncomplete` a decline throws and leaves the sub trialing (rolled back) instead of dropping it to past_due. */
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

/** Swaps the price now with no Stripe proration — we compute our own minutes-based credit and charge the delta separately. */
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

/** Re-picks the plan on an in-trial sub without opening a second one (which would orphan the first and log a duplicate "trial started"). No charge; returns a SetupIntent secret so the card step still works. */
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

/** New subscription charged right now (no trial), for renewing after a canceled one. Throws on a declined card. */
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

/** Currency switch on a brand-new customer — a Stripe customer is locked to its first invoice's currency, and cards can't move between customers so a new one must be collected. `default_incomplete` so the old sub keeps running until this one is actually paid. */
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

/** Renews now by re-anchoring the billing cycle (minutes ran out early). Full period billed, no proration credit; a declined card throws so the caller can flip to past_due. */
export async function renewSubscriptionNow(
  subscriptionId: string,
  opts: {
    /** Idempotency for concurrent AUTOMATIC renewals. Off for user retries — Stripe caches the decline under the key too, so a fixed card would get the old decline back. */
    dedupeConcurrent?: boolean;
  } = {},
): Promise<{ currentPeriodEnd: number | null; active: boolean; releasedScheduleId: string | null }> {
  // A trial-born sub may have no default card, which fails the off-session charge.
  await ensureSubscriptionDefaultPaymentMethod(subscriptionId);

  // A schedule-managed sub (pending downgrade) rejects billing_cycle_anchor writes and would
  // drop the user to past_due. Release it first — its cycle boundary is being consumed now anyway.
  const sub = await stripe().subscriptions.retrieve(subscriptionId);
  const scheduleId = typeof sub.schedule === "string" ? sub.schedule : sub.schedule?.id ?? null;
  if (scheduleId) await releaseSchedule(scheduleId);

  // Key derived from the cycle being replaced: racing requests read the same period end
  // and collapse into one charge; a genuine later renewal gets a new key.
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

/** Queues a downgrade for the next renewal via a subscription schedule, so billing flips atomically at the cycle boundary. */
export async function scheduleDowngrade(
  subscriptionId: string,
  newPriceId: string,
): Promise<{ scheduleId: string; effectiveAt: number | null }> {
  const sub = await stripe().subscriptions.retrieve(subscriptionId, { expand: ["discounts"] });
  const item = sub.items.data[0];
  const currentPriceId = typeof item.price === "string" ? item.price : item.price.id;

  // A live coupon MUST be restated on every phase: an unspecified `discounts` inherits
  // from the CUSTOMER, and ours sit on the subscription — so it'd be silently stripped.
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
        // The cheaper phase carries it too — a coupon is billing CYCLES, not a plan.
        items: [{ price: newPriceId, quantity: 1 }],
        ...(discounts.length > 0 ? { discounts } : {}),
      },
    ],
  });
  return { scheduleId: schedule.id, effectiveAt: sub.current_period_end ?? null };
}

/** Rewrites the discount on a pending schedule's future phases. `scheduleDowngrade` bakes in the coupon of the moment, so a later change (admin grant, cycles spent) would otherwise re-apply the OLD coupon at the boundary. Null clears; released/completed schedules are a no-op. */
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
    // "" to clear, never [] — the form encoder drops an empty array entirely
    // (see detachSubscriptionDiscount), leaving Stripe to inherit from the customer.
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

// Card for a standalone invoice: the customer's invoice default, else the latest saved
// card. Null when there's none so Stripe surfaces the real "no card" error.
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

/** One-time charge via a standalone invoice (upgrade delta, add-ons). Returns paid:false rather than throwing when collection fails. */
export async function chargeOneTime(
  customerId: string,
  amountCents: number,
  description: string,
  currency = "usd",
): Promise<{ invoiceId: string; paid: boolean }> {
  if (amountCents <= 0) return { invoiceId: "", paid: true };
  const s = stripe();

  // Draft first, line item attached BY ID (a pending customer-level item gets swept onto the NEXT
  // subscription invoice). Card pinned ON the invoice: standalone invoices bill the customer default, not the sub's.
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
    // finalizeInvoice doesn't take the money — `pay` does. Reading status after
    // finalize returned "open" and made every upgrade look like a failed charge.
    const paidInvoice =
      finalized.status === "paid" ? finalized : await s.invoices.pay(draft.id);
    return { invoiceId: paidInvoice.id, paid: paidInvoice.status === "paid" };
  } catch (e) {
    // VOID the invoice so an uncollected charge never resurfaces on the next renewal.
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

/** Card fingerprint (stable per physical card) + owning customer — stops one card opening a second trial. Null for non-card methods. */
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

/** Repair path for a card that reached us unattached (the SetupIntent normally does this). Throws if Stripe refuses. */
export async function attachPaymentMethod(
  paymentMethodId: string,
  customerId: string,
): Promise<void> {
  await stripe().paymentMethods.attach(paymentMethodId, { customer: customerId });
}

/** Latest PAID invoice for a subscription. `amount_paid` is post-discount — exactly what proration credit must be a share of. */
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

/** Toggles cancel_at_period_end. A schedule-managed sub (pending downgrade) rejects cancelation writes, so the schedule is released first — current plan untouched, only the queued change goes. Returns the released id so the caller can clear its bookkeeping. */
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

/** Live auto-renew state from Stripe — a safety net so a portal cancel is honoured before an early renewal even if its webhook hasn't landed. */
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

// Product/price sync for admin plans. Stripe prices are immutable: a change = new price + old archived.
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

// Coupons mirror to Stripe. Duration is only "once" or "forever", never duration_in_months —
// early renewals fit several cycles in one month, so WE count cycles and detach when spent.
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

/** Sets the subscription's discount, replacing whatever was there (one live discount per account). */
export async function attachSubscriptionDiscount(
  subscriptionId: string,
  couponId: string,
): Promise<void> {
  await stripe().subscriptions.update(subscriptionId, {
    discounts: [{ coupon: couponId }],
  });
}

/** Clears the discount. MUST be "" not [] — stripe-node's form encoder emits nothing for an empty array, so `[]` was a silent no-op that left a 2-cycle coupon discounting forever. */
export async function detachSubscriptionDiscount(subscriptionId: string): Promise<void> {
  await stripe().subscriptions.update(subscriptionId, { discounts: "" });
}

/** Coupon currently on a subscription, or null (also null for a gone subscription — drift checks must not break). */
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
  // Hide Stripe's auto $0 invoices (trial start, zero-net swaps) — a wall of "$0 Paid" rows is noise.
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

// Reuse the existing customer unless it's locked to a different currency (set on first invoice, never changes).
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

/** Trial subscription (card via Elements). No immediate charge, so Stripe returns a pending SetupIntent whose client_secret saves the card; the trial end auto-charges it. */
export async function createTrialSubscription(opts: {
  email: string;
  name?: string;
  priceIds: string[]; // plan price first, then any add-on prices
  trialDays: number;
  existingCustomerId?: string | null;
  /** Plan currency (e.g. "usd"/"aud"). Used to detect a currency-locked customer. */
  currency?: string;
  /** Coupon applied at creation — /confirm-card bills the first invoice right away, so a follow-up attach would be too late. */
  couponId?: string | null;
  /** Stamped on a new Stripe customer so a payment finds its brand even if our index is lost. */
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

  // A currency-locked customer can't take a subscription in another currency — mint a fresh one.
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
    // Card only — keeps Klarna/pay-later out of the SetupIntent and the Payment Element.
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
