import { randomBytes } from "node:crypto";
import type { Brand } from "@prisma/client";
import { prisma } from "../prisma.js";
import { cacheBrandRow, provisionBrand } from "./brands.js";
import { tenantFor } from "./tenantDb.js";

// Ready-made customer databases (docs/brand-as-customer-plan.md). Creating a database — a Neon project plus every
// tenant migration — takes seconds to tens of seconds, too long to keep someone waiting at "Verify". A few spare
// customer-state rows are kept provisioned in the background; a sign-up claims one by renaming it, which is a single
// row update. When none is ready the sign-up simply provisions its own, as before.

/** How many ready databases to keep in reserve. 0 turns the pool off. */
export function poolTarget(): number {
  const raw = Number(process.env.CUSTOMER_DB_POOL_SIZE ?? "2");
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 20) : 0;
}

let refilling: Promise<number> | null = null;

/** A spare still "provisioning" after this long was abandoned by a process that restarted mid-setup. */
const STUCK_SETUP_MS = 10 * 60 * 1000;

/** How long after a claim the pool is topped up — long enough for the claiming sign-up to finish. */
const REFILL_DELAY_MS = 30_000;

/** Tops the pool up to its target, one database at a time. Re-entrant calls share the run in flight. */
export function refillCustomerPool(): Promise<number> {
  if (!refilling) {
    refilling = (async () => {
      const target = poolTarget();
      if (!target) return 0;
      // Spares not ready yet still count against the target, so a broken provider can't make the refill create
      // databases without end. A failed one is retried in place, and so is one stuck mid-setup — the process that
      // was setting it up restarted (a deploy) — once it is clearly abandoned. Setup is idempotent.
      const spares = await prisma.brand.findMany({
        where: { poolSpare: true },
        select: { id: true, status: true, updatedAt: true },
      });
      const abandoned = Date.now() - STUCK_SETUP_MS;
      for (const s of spares) {
        if (s.status === "failed" || (s.status === "provisioning" && s.updatedAt.getTime() < abandoned)) {
          s.status = (await provisionBrand(s.id)).status;
        }
      }
      // Open each ready spare's connection now, so the sign-up that claims it doesn't pay for that.
      await Promise.all(spares.filter((s) => s.status === "active").map((s) => tenantFor(s.id).catch(() => null)));
      let made = 0;
      for (let have = spares.length; have < target; have++) {
        const row = await prisma.brand.create({
          data: {
            name: "Spare account",
            slug: `c-spare-${randomBytes(6).toString("hex")}`,
            kind: "customer",
            status: "provisioning",
            poolSpare: true,
          },
        });
        const ready = await provisionBrand(row.id);
        if (ready.status !== "active") break; // the provider is failing; try again next round
        await tenantFor(ready.id).catch(() => null);
        made++;
      }
      return made;
    })().finally(() => {
      refilling = null;
    });
  }
  return refilling;
}

/** Takes a ready spare for a new sign-up in ONE statement: renamed to the account's own label and name, its owner
 *  named, its clock restarted (the abandoned sign-up sweep counts from the claim). `SKIP LOCKED` hands two racing
 *  sign-ups two different spares, never one. Null when none is ready. */
export async function claimSpare(slug: string, name: string, ownerUserId?: string): Promise<Brand | null> {
  const rows = await prisma.$queryRaw<Brand[]>`
    UPDATE "brands"
    SET "poolSpare" = false, "slug" = ${slug}, "name" = ${name}, "ownerUserId" = ${ownerUserId ?? null},
        "createdAt" = now(), "updatedAt" = now()
    WHERE "id" = (
      SELECT "id" FROM "brands" WHERE "poolSpare" AND "status" = 'active'
      ORDER BY "createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    RETURNING *`;
  if (!rows.length) return null;
  // Topped up a little later, not now: provisioning a replacement is dozens of statements, and on the same
  // connection pool it would queue ahead of the very sign-up that just claimed this spare.
  setTimeout(() => void refillCustomerPool().catch((e) => console.error("[customer pool] refill failed:", e)), REFILL_DELAY_MS).unref?.();
  return cacheBrandRow(rows[0]);
}
