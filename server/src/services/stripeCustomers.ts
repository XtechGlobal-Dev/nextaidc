import { prisma } from "../prisma.js";
import { allTenants } from "./tenantDb.js";
import { isStripeConfigured, stripe } from "./stripe.js";

/* ------------------------------------------------------------------ *
 *  Which brand a Stripe customer belongs to.
 *
 *  Stripe stays one account — the platform's — while every brand's
 *  customers live in that brand's own database. So the moment a Stripe
 *  event arrives, the first question is "whose is this?", and the answer
 *  has to come from somewhere the event can name: the Stripe customer
 *  id. `stripe_customers` maps it to a brand and a customer. It is
 *  written when the Stripe customer is created, stamped on the Stripe
 *  object as metadata for good measure, and — for customers from before
 *  the index existed — rebuilt from the profile that holds the id.
 * ------------------------------------------------------------------ */

export interface StripeOwner {
  brandId: string;
  userId: string;
}

export interface StripeOwnerInput {
  brandId: string | null | undefined;
  userId: string;
}

/** Remember which brand and customer a Stripe customer id belongs to. A
 *  platform-level account has no brand and nothing to route, so it is skipped. */
export async function indexStripeCustomer(stripeCustomerId: string, owner: StripeOwnerInput): Promise<void> {
  if (!stripeCustomerId || !owner.brandId) return;
  await prisma.stripeCustomer.upsert({
    where: { stripeCustomerId },
    create: { stripeCustomerId, brandId: owner.brandId, userId: owner.userId },
    update: { brandId: owner.brandId, userId: owner.userId },
  });
}

/** The metadata a Stripe customer is created with — the owner, on the Stripe
 *  object itself, so a lost index row can be rebuilt from Stripe. */
export function stripeOwnerMetadata(owner: StripeOwnerInput | null | undefined): Record<string, string> {
  if (!owner?.brandId) return {};
  return { brandId: owner.brandId, userId: owner.userId };
}

/** Stamp the owner onto an existing Stripe customer. Best-effort: Stripe being
 *  down must not fail the billing action this rides along with. */
export async function stampStripeCustomer(stripeCustomerId: string, owner: StripeOwnerInput): Promise<void> {
  if (!isStripeConfigured() || !owner.brandId) return;
  try {
    await stripe().customers.update(stripeCustomerId, { metadata: stripeOwnerMetadata(owner) });
  } catch (e) {
    console.warn(`[stripe] could not stamp customer ${stripeCustomerId}:`, e instanceof Error ? e.message : e);
  }
}

/**
 * Whose Stripe customer is this?
 *
 * The index first. Failing that, the profile that holds the id (or is in the
 * middle of switching to it) and its owner's brand — and the index is repaired
 * on the way out, so the next event is one lookup. Null means no brand holds
 * this customer: the caller parks the event rather than guessing.
 */
export async function resolveStripeCustomer(stripeCustomerId: string | null | undefined): Promise<StripeOwner | null> {
  if (!stripeCustomerId) return null;
  const indexed = await prisma.stripeCustomer.findUnique({ where: { stripeCustomerId } });
  if (indexed) return { brandId: indexed.brandId, userId: indexed.userId };

  // Not indexed: look in each brand's database in turn — a customer created
  // before the index existed. Repaired on the way out.
  for (const { brandId, db } of await allTenants()) {
    const profile = await db.profile.findFirst({
      where: { OR: [{ stripeCustomerId }, { pendingSwitchCustomerId: stripeCustomerId }] },
      select: { userId: true },
    });
    if (!profile) continue;
    await indexStripeCustomer(stripeCustomerId, { brandId, userId: profile.userId }).catch(() => {});
    return { brandId, userId: profile.userId };
  }
  return null;
}

/**
 * Index every Stripe customer any brand's database knows about. A one-off after
 * this index was introduced, and the repair tool when it is suspected of
 * gaps. Returns how many were (re)written.
 */
export async function backfillStripeCustomerIndex(): Promise<number> {
  let written = 0;
  for (const { brandId, db } of await allTenants()) {
    const profiles = await db.profile.findMany({
      where: { OR: [{ stripeCustomerId: { not: null } }, { pendingSwitchCustomerId: { not: null } }] },
      select: { userId: true, stripeCustomerId: true, pendingSwitchCustomerId: true },
    });
    for (const p of profiles) {
      for (const id of [p.stripeCustomerId, p.pendingSwitchCustomerId]) {
        if (!id) continue;
        await indexStripeCustomer(id, { brandId, userId: p.userId });
        written++;
      }
    }
  }
  return written;
}
