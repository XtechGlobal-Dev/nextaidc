import { prisma } from "../prisma.js";
import { allTenants } from "./tenantDb.js";
import { isStripeConfigured, stripe } from "./stripe.js";

// One Stripe account, many brand DBs: `stripe_customers` maps a Stripe customer id to
// its brand and user so a webhook knows which DB to open. Also stamped as Stripe metadata.

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

/** Whose Stripe customer is this? Index first, then a scan of every brand's profiles (repairing the index). Null means nobody holds it — park the event, don't guess. */
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

/** Re-indexes every Stripe customer id any brand's profiles hold. Repair tool for suspected gaps; returns how many rows were written. */
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
