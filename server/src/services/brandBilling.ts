import type Stripe from "stripe";
import type { Brand, BrandBilling } from "@prisma/client";
import { prisma } from "../prisma.js";
import { badRequest, notFound } from "../lib/http.js";
import { isStripeConfigured, stripe } from "./stripe.js";
import { customerIdOf } from "./stripeUnrouted.js";
import { loadBrands } from "./brands.js";
import {
  BRAND_MODULES,
  brandFeaturePrices,
  brandModuleLabel,
  brandModuleSwitches,
  brandOwesPlatform,
  brandPurchasedFeatures,
  type BrandModuleId,
} from "./brandSetup.js";
import {
  alertBrand,
  billingLocked,
  brandUsageSummary,
  ensureBillingRow,
  refreshServiceHold,
  BRAND_BILLING_GRACE_DAYS,
  type BrandUsageSummary,
} from "./brandUsage.js";

// The brand as a customer of the PLATFORM — the opposite direction to the wallet. One Stripe
// subscription per brand holds its fixed monthly fee and every feature add-on it has bought, each an
// item with inline price_data (per-brand amounts, so no Price objects to manage). Stripe is the source
// of truth for payment; `brand_billing` mirrors it, and the webhook keeps the mirror current.

const KIND = "brand_billing";
const FEE_PRODUCT_ID = "brand_platform_fee";
const featureProductId = (id: BrandModuleId) => `brand_feature_${id}`;

/* ------------------------------ Stripe plumbing ------------------------------ */

const knownProducts = new Set<string>();

/** Products get fixed ids, so they're found again rather than duplicated. */
async function ensureProduct(id: string, name: string): Promise<string> {
  if (knownProducts.has(id)) return id;
  try {
    await stripe().products.retrieve(id);
  } catch (e) {
    if ((e as { code?: string }).code !== "resource_missing") throw e;
    await stripe().products.create({ id, name, metadata: { kind: KIND } });
  }
  knownProducts.add(id);
  return id;
}

type ItemPrice = { currency: string; product: string; unit_amount: number; recurring: { interval: "month" } };

async function feePrice(brand: Brand): Promise<ItemPrice> {
  return {
    currency: brand.platformFeeCurrency,
    product: await ensureProduct(FEE_PRODUCT_ID, "Brand platform fee"),
    unit_amount: brand.platformFeeCents,
    recurring: { interval: "month" },
  };
}

async function featurePrice(brand: Brand, id: BrandModuleId, cents: number): Promise<ItemPrice> {
  return {
    currency: brand.platformFeeCurrency,
    product: await ensureProduct(featureProductId(id), `Add-on: ${brandModuleLabel(id)}`),
    unit_amount: cents,
    recurring: { interval: "month" },
  };
}

/** Stripe's error message for a refused card, as a 400 the brand admin can read. */
function paymentError(e: unknown): Error {
  const err = e as { type?: string; message?: string };
  if (err?.type === "StripeCardError" || err?.type === "StripeInvalidRequestError") {
    return badRequest(err.message ?? "Your card was declined.");
  }
  return e instanceof Error ? e : new Error(String(e));
}

/** Stripe's subscription status, collapsed onto ours. */
export function billingStatusOf(stripeStatus: string): BrandBilling["status"] {
  if (stripeStatus === "active" || stripeStatus === "trialing") return "active";
  if (stripeStatus === "canceled" || stripeStatus === "incomplete_expired") return "canceled";
  return "past_due";
}

async function brandAndBilling(brandId: string): Promise<{ brand: Brand; billing: BrandBilling }> {
  const brand = await prisma.brand.findUnique({ where: { id: brandId } });
  if (!brand) throw notFound("Brand not found");
  return { brand, billing: await ensureBillingRow(brandId) };
}

async function ensureCustomer(brand: Brand, billing: BrandBilling, email: string): Promise<string> {
  if (billing.stripeCustomerId) return billing.stripeCustomerId;
  const customer = await stripe().customers.create(
    { name: brand.name, email, metadata: { kind: KIND, brandId: brand.id } },
    { idempotencyKey: `brand-customer-${brand.id}` },
  );
  await prisma.brandBilling.update({ where: { brandId: brand.id }, data: { stripeCustomerId: customer.id } });
  return customer.id;
}

/** Mirrors a subscription onto the billing row. A payment that just cleared resets the failure clock. */
async function applySubscription(brandId: string, sub: Stripe.Subscription): Promise<void> {
  const status = billingStatusOf(sub.status);
  const current = await prisma.brandBilling.findUnique({ where: { brandId }, select: { pastDueSince: true } });
  await prisma.brandBilling.update({
    where: { brandId },
    data: {
      stripeSubscriptionId: status === "canceled" ? null : sub.id,
      status,
      currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
      pastDueSince: status === "active" ? null : (current?.pastDueSince ?? new Date()),
    },
  });
}

async function setPurchased(brandId: string, ids: BrandModuleId[]): Promise<void> {
  await prisma.brand.update({ where: { id: brandId }, data: { purchasedFeatures: [...new Set(ids)] } });
  await loadBrands();
}

/** The live subscription with its items, or null when there isn't one. */
async function liveSubscription(billing: BrandBilling): Promise<Stripe.Subscription | null> {
  if (!billing.stripeSubscriptionId) return null;
  const sub = await stripe().subscriptions.retrieve(billing.stripeSubscriptionId);
  return billingStatusOf(sub.status) === "canceled" ? null : sub;
}

const itemKind = (item: Stripe.SubscriptionItem) => item.metadata?.kind ?? "";
const itemModule = (item: Stripe.SubscriptionItem) => item.metadata?.module ?? "";

/* ---------------------------------- View ---------------------------------- */

export type FeatureAccess = "included" | "addon" | "off";

export interface BrandFeatureView {
  id: BrandModuleId;
  label: string;
  description: string;
  access: FeatureAccess;
  /** Monthly price in cents when sold as an add-on. */
  priceCents: number | null;
  purchased: boolean;
}

export interface BrandInvoiceView {
  id: string;
  number: string;
  amountCents: number;
  currency: string;
  status: string;
  created: string;
  url: string;
}

export interface BrandBillingView {
  stripeReady: boolean;
  /** The brand plan it's on; null = billing set by hand. */
  plan: { id: string; name: string } | null;
  /** Does this brand pay the platform anything? */
  required: boolean;
  feeCents: number;
  currency: string;
  /** Fee plus every bought add-on. */
  monthlyTotalCents: number;
  /** none | awaiting_card | active | past_due | canceled */
  status: string;
  /** Admin panel limited to Billing until paid. */
  locked: boolean;
  graceDays: number;
  /** When the AI pauses if nothing is paid by then; null when paid up. */
  pausesAt: string | null;
  currentPeriodEnd: string | null;
  lastPaidAt: string | null;
  lastPaidCents: number | null;
  card: { brand: string; last4: string } | null;
  features: BrandFeatureView[];
  usage: BrandUsageSummary;
  invoices: BrandInvoiceView[];
}

export function brandFeatures(brand: Brand): BrandFeatureView[] {
  const switches = brandModuleSwitches(brand);
  const prices = brandFeaturePrices(brand);
  const bought = new Set(brandPurchasedFeatures(brand));
  return BRAND_MODULES.map((m) => {
    const price = prices[m.id] ?? null;
    const access: FeatureAccess = !switches[m.id] ? "off" : price != null ? "addon" : "included";
    return {
      id: m.id,
      label: m.label,
      description: m.description,
      access,
      priceCents: access === "addon" ? price : null,
      purchased: access === "addon" && bought.has(m.id),
    };
  });
}

async function recentInvoices(customerId: string | null): Promise<BrandInvoiceView[]> {
  if (!customerId || !isStripeConfigured()) return [];
  try {
    const list = await stripe().invoices.list({ customer: customerId, limit: 12 });
    return list.data.map((inv) => ({
      id: inv.id ?? "",
      number: inv.number ?? "",
      amountCents: inv.status === "paid" ? inv.amount_paid : inv.amount_due,
      currency: inv.currency,
      status: inv.status ?? "",
      created: new Date(inv.created * 1000).toISOString(),
      url: inv.hosted_invoice_url ?? "",
    }));
  } catch {
    return []; // the page still works with Stripe unreachable
  }
}

export async function brandBillingView(brandId: string, opts: { invoices?: boolean } = {}): Promise<BrandBillingView> {
  const brand = await prisma.brand.findUnique({
    where: { id: brandId },
    include: { billing: true, brandPlan: { select: { id: true, name: true } } },
  });
  if (!brand) throw notFound("Brand not found");
  const billing = brand.billing;
  const required = brandOwesPlatform(brand);
  const features = brandFeatures(brand);
  const addOnTotal = features.reduce((sum, f) => sum + (f.purchased ? (f.priceCents ?? 0) : 0), 0);
  const status = billing?.status ?? (required ? "awaiting_card" : "none");

  const clock = !billing || status === "active" ? null : status === "awaiting_card" ? billing.requiredSince : (billing.pastDueSince ?? billing.requiredSince);
  const pausesAt =
    required && clock ? new Date(clock.getTime() + BRAND_BILLING_GRACE_DAYS * 86_400_000).toISOString() : null;

  return {
    stripeReady: isStripeConfigured(),
    plan: brand.brandPlan,
    required,
    feeCents: brand.platformFeeCents,
    currency: brand.platformFeeCurrency,
    monthlyTotalCents: brand.platformFeeCents + addOnTotal,
    status: required ? status : billing?.stripeSubscriptionId ? status : "none",
    locked: billingLocked(brand, billing),
    graceDays: BRAND_BILLING_GRACE_DAYS,
    pausesAt,
    currentPeriodEnd: billing?.currentPeriodEnd?.toISOString() ?? null,
    lastPaidAt: billing?.lastPaidAt?.toISOString() ?? null,
    lastPaidCents: billing?.lastPaidCents ?? null,
    card: billing?.cardLast4 ? { brand: billing.cardBrand, last4: billing.cardLast4 } : null,
    features,
    usage: await brandUsageSummary(brand),
    invoices: opts.invoices ? await recentInvoices(billing?.stripeCustomerId ?? null) : [],
  };
}

/* --------------------------------- Actions -------------------------------- */

/** Starts saving a card: a SetupIntent on the brand's own Stripe customer. */
export async function createBillingSetupIntent(brandId: string, email: string): Promise<{ clientSecret: string }> {
  const { brand, billing } = await brandAndBilling(brandId);
  const customer = await ensureCustomer(brand, billing, email);
  const intent = await stripe().setupIntents.create({
    customer,
    usage: "off_session",
    payment_method_types: ["card"],
    metadata: { kind: KIND, brandId },
  });
  if (!intent.client_secret) throw new Error("Stripe returned no client secret");
  return { clientSecret: intent.client_secret };
}

/**
 * Makes a confirmed card the brand's card and settles what's owed with it: starts the subscription on
 * first activation (charged now — a decline throws, nothing is created), or pays the open invoice when
 * a renewal failed. With nothing to bill yet (no fee, no add-ons) the card is simply kept for later.
 */
export async function activateBrandBilling(brandId: string, paymentMethodId: string): Promise<void> {
  const { brand, billing } = await brandAndBilling(brandId);
  const customer = billing.stripeCustomerId;
  if (!customer) throw badRequest("Start again — no card setup is in progress.");

  const pm = await stripe().paymentMethods.retrieve(paymentMethodId);
  const pmCustomer = typeof pm.customer === "string" ? pm.customer : pm.customer?.id;
  if (pmCustomer !== customer) throw badRequest("That card belongs to a different account.");

  await stripe().customers.update(customer, { invoice_settings: { default_payment_method: paymentMethodId } });
  await prisma.brandBilling.update({
    where: { brandId },
    data: { cardBrand: pm.card?.brand ?? "", cardLast4: pm.card?.last4 ?? "" },
  });

  const live = await liveSubscription(billing);
  if (live) {
    await stripe().subscriptions.update(live.id, { default_payment_method: paymentMethodId });
    // A failed renewal leaves its invoice open — pay it now with the new card.
    const latest = live.latest_invoice;
    const latestId = typeof latest === "string" ? latest : latest?.id;
    if (latestId) {
      const invoice = await stripe().invoices.retrieve(latestId);
      if (invoice.status === "open") {
        try {
          await stripe().invoices.pay(latestId, { payment_method: paymentMethodId });
        } catch (e) {
          throw paymentError(e);
        }
      }
    }
    await applySubscription(brandId, await stripe().subscriptions.retrieve(live.id));
  } else {
    const items: Stripe.SubscriptionCreateParams.Item[] = [];
    if (brand.platformFeeCents > 0) items.push({ price_data: await feePrice(brand), metadata: { kind: "fee" } });
    if (items.length) {
      let sub: Stripe.Subscription;
      try {
        sub = await stripe().subscriptions.create(
          {
            customer,
            items,
            default_payment_method: paymentMethodId,
            // Charge now or fail now — never a half-made subscription.
            payment_behavior: "error_if_incomplete",
            metadata: { kind: KIND, brandId },
          },
          { idempotencyKey: `brand-sub-${brandId}-${paymentMethodId}` },
        );
      } catch (e) {
        throw paymentError(e);
      }
      await applySubscription(brandId, sub);
      await prisma.brandBilling.update({
        where: { brandId },
        data: { lastPaidAt: new Date(), lastPaidCents: brand.platformFeeCents },
      });
    }
  }
  await refreshServiceHold(brandId);
}

/**
 * A brand request's saved card becomes the brand's own at "Complete setup": its Stripe customer is re-labelled
 * as this brand's, and — when the brand owes a fee — the first month is charged on it right away (the same
 * path as the brand admin paying: a decline throws, nothing half-made). Without a fee, the card is just kept.
 */
export async function adoptRequestCard(
  brandId: string,
  card: { stripeCustomerId: string; paymentMethodId: string; cardBrand: string; cardLast4: string },
): Promise<void> {
  await prisma.brandBilling.upsert({
    where: { brandId },
    create: { brandId, stripeCustomerId: card.stripeCustomerId, cardBrand: card.cardBrand, cardLast4: card.cardLast4 },
    update: { stripeCustomerId: card.stripeCustomerId, cardBrand: card.cardBrand, cardLast4: card.cardLast4 },
  });
  const brand = await prisma.brand.findUnique({ where: { id: brandId }, select: { name: true } });
  await stripe().customers.update(card.stripeCustomerId, {
    name: brand?.name,
    metadata: { kind: KIND, brandId },
  });
  await activateBrandBilling(brandId, card.paymentMethodId);
}

/** Buys a feature add-on: charged now for the rest of the month (prorated), then monthly. The module
 *  unlocks the moment the charge clears. */
export async function buyFeature(brandId: string, moduleId: BrandModuleId): Promise<void> {
  const { brand, billing } = await brandAndBilling(brandId);
  const feature = brandFeatures(brand).find((f) => f.id === moduleId);
  if (!feature || feature.access !== "addon" || feature.priceCents == null) {
    throw badRequest("That feature isn't sold as an add-on on this brand.");
  }
  if (feature.purchased) return;
  if (!billing.stripeCustomerId || !billing.cardLast4) throw badRequest("Add a card first.");
  if (billing.status === "past_due") throw badRequest("Settle the overdue payment before adding features.");
  if (billing.status === "awaiting_card" && brand.platformFeeCents > 0) {
    throw badRequest("Activate your subscription before adding features.");
  }

  const price = await featurePrice(brand, moduleId, feature.priceCents);
  const live = await liveSubscription(billing);
  try {
    if (live) {
      await stripe().subscriptionItems.create(
        {
          subscription: live.id,
          price_data: price,
          metadata: { kind: "feature", module: moduleId },
          proration_behavior: "always_invoice",
          payment_behavior: "error_if_incomplete",
        },
        // Same minute, same purchase: a double-click can't buy it twice.
        { idempotencyKey: `brand-feature-${brandId}-${moduleId}-${live.id}-${Math.floor(Date.now() / 60_000)}` },
      );
      await applySubscription(brandId, await stripe().subscriptions.retrieve(live.id));
    } else {
      // No fee to hang it on (a fee-free brand): the add-on opens the subscription.
      const sub = await stripe().subscriptions.create({
        customer: billing.stripeCustomerId,
        items: [{ price_data: price, metadata: { kind: "feature", module: moduleId } }],
        payment_behavior: "error_if_incomplete",
        metadata: { kind: KIND, brandId },
      });
      await applySubscription(brandId, sub);
    }
  } catch (e) {
    throw paymentError(e);
  }
  await setPurchased(brandId, [...brandPurchasedFeatures(brand), moduleId]);
}

/** Stops an add-on now: no refund, no further charge, and the module locks again. */
export async function cancelFeature(brandId: string, moduleId: BrandModuleId): Promise<void> {
  const { brand, billing } = await brandAndBilling(brandId);
  const live = await liveSubscription(billing);
  if (live) {
    const item = live.items.data.find((i) => itemKind(i) === "feature" && itemModule(i) === moduleId);
    if (item) {
      if (live.items.data.length === 1) {
        await stripe().subscriptions.cancel(live.id);
        await applySubscription(brandId, await stripe().subscriptions.retrieve(live.id));
      } else {
        await stripe().subscriptionItems.del(item.id, { proration_behavior: "none" });
      }
    }
  }
  await setPurchased(brandId, brandPurchasedFeatures(brand).filter((id) => id !== moduleId));
}

/**
 * Brings Stripe in line after the super admin changed the fee or add-on prices, or took a feature off
 * sale. New amounts apply from the next invoice (no proration either way). A bought feature that is no
 * longer an add-on stops being charged — it's now included, or switched off.
 */
export async function syncBrandSubscription(brandId: string): Promise<void> {
  const { brand, billing } = await brandAndBilling(brandId);
  const prices = brandFeaturePrices(brand);
  const switches = brandModuleSwitches(brand);
  const keep = brandPurchasedFeatures(brand).filter((id) => prices[id] !== undefined && switches[id]);
  if (keep.length !== brandPurchasedFeatures(brand).length) await setPurchased(brandId, keep);

  if (!isStripeConfigured()) return;
  const live = await liveSubscription(billing);
  if (live) {
    const wanted = new Map<string, ItemPrice>();
    if (brand.platformFeeCents > 0) wanted.set("fee", await feePrice(brand));
    for (const id of keep) wanted.set(`feature:${id}`, await featurePrice(brand, id, prices[id]!));

    if (wanted.size === 0) {
      await stripe().subscriptions.cancel(live.id);
      await applySubscription(brandId, await stripe().subscriptions.retrieve(live.id));
      return;
    }
    const seen = new Set<string>();
    for (const item of live.items.data) {
      const key = itemKind(item) === "fee" ? "fee" : `feature:${itemModule(item)}`;
      const want = wanted.get(key);
      if (!want) {
        await stripe().subscriptionItems.del(item.id, { proration_behavior: "none" });
        continue;
      }
      seen.add(key);
      if (item.price.unit_amount !== want.unit_amount) {
        await stripe().subscriptionItems.update(item.id, { price_data: want, proration_behavior: "none" });
      }
    }
    for (const [key, price] of wanted) {
      if (seen.has(key)) continue;
      await stripe().subscriptionItems.create({
        subscription: live.id,
        price_data: price,
        metadata: key === "fee" ? { kind: "fee" } : { kind: "feature", module: key.slice("feature:".length) },
        proration_behavior: "none",
      });
    }
  }
  await refreshServiceHold(brandId);
}

/** Stops charging a brand that's going offline (deactivated or deleted). Best-effort on Stripe's side;
 *  the mirror is updated either way so the brand never reads as paying. */
export async function cancelBrandBilling(brandId: string): Promise<void> {
  const billing = await prisma.brandBilling.findUnique({ where: { brandId } });
  if (!billing) return;
  if (billing.stripeSubscriptionId && isStripeConfigured()) {
    try {
      await stripe().subscriptions.cancel(billing.stripeSubscriptionId);
    } catch (e) {
      console.warn(`[brand-billing] could not cancel ${billing.stripeSubscriptionId}:`, e);
    }
  }
  await prisma.brandBilling.update({
    where: { brandId },
    data: { status: "canceled", stripeSubscriptionId: null },
  });
  await prisma.brand.update({ where: { id: brandId }, data: { purchasedFeatures: [] } }).catch(() => {});
  await loadBrands();
}

/** A reactivated brand starts paying afresh: a new grace clock, not the one from before it went offline. */
export async function restartBrandBilling(brandId: string): Promise<void> {
  await prisma.brandBilling.updateMany({
    where: { brandId, status: "canceled" },
    data: { status: "awaiting_card", requiredSince: new Date(), pastDueSince: null },
  });
}

/** Refuses a currency change while a subscription is live — Stripe can't re-currency one. */
export async function assertCurrencyChangeable(brandId: string, nextCurrency: string | undefined): Promise<void> {
  if (!nextCurrency) return;
  const brand = await prisma.brand.findUnique({ where: { id: brandId }, include: { billing: true } });
  if (!brand || brand.platformFeeCurrency === nextCurrency.toLowerCase()) return;
  if (brand.billing?.stripeSubscriptionId) {
    throw badRequest(
      `${brand.name} is already billed in ${brand.platformFeeCurrency.toUpperCase()}. The currency can't change while its subscription is live.`,
    );
  }
}

/* --------------------------------- Webhook -------------------------------- */

/** Handles a Stripe event when it's about a brand's own billing; false = not ours, route it as usual.
 *  Runs before customer routing, which would otherwise park these as "unrouted". */
export async function handleBrandBillingEvent(event: Stripe.Event): Promise<boolean> {
  const customerId = customerIdOf(event.data.object);
  if (!customerId) return false;
  const billing = await prisma.brandBilling.findUnique({ where: { stripeCustomerId: customerId } });
  if (!billing) return false;
  const brandId = billing.brandId;
  const HANDLED = ["invoice.paid", "invoice.payment_failed", "customer.subscription.updated", "customer.subscription.deleted"];
  if (!HANDLED.includes(event.type)) return true; // ours, nothing to do

  try {
    switch (event.type) {
      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        await prisma.brandBilling.update({
          where: { brandId },
          data: { status: "active", pastDueSince: null, lastPaidAt: new Date(), lastPaidCents: invoice.amount_paid },
        });
        const subId = typeof invoice.subscription === "string" ? invoice.subscription : invoice.subscription?.id;
        if (subId && subId === billing.stripeSubscriptionId) {
          await applySubscription(brandId, await stripe().subscriptions.retrieve(subId));
        }
        break;
      }
      case "invoice.payment_failed": {
        await prisma.brandBilling.update({
          where: { brandId },
          data: { status: "past_due", pastDueSince: billing.pastDueSince ?? new Date() },
        });
        const brand = await prisma.brand.findUnique({ where: { id: brandId }, select: { name: true } });
        void alertBrand(brandId, brand?.name ?? "Brand", {
          type: "billing",
          title: "Platform payment failed",
          message: `Your card was declined. Update it from Billing within ${BRAND_BILLING_GRACE_DAYS} days to keep your customers' AI running.`,
        });
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        if (sub.id !== billing.stripeSubscriptionId) break;
        await applySubscription(brandId, event.type === "customer.subscription.deleted" ? { ...sub, status: "canceled" } : sub);
        // A subscription that ends takes its add-ons with it.
        if (event.type === "customer.subscription.deleted") await setPurchased(brandId, []);
        break;
      }
    }
  } finally {
    await refreshServiceHold(brandId).catch(() => {});
  }
  return true;
}
