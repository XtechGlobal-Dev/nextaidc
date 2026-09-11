import type { Prisma as TenantPrisma } from "@prisma/tenant-client";
import { prisma } from "../prisma.js";
import { callDb } from "./tenantDb.js";

/* ------------------------------------------------------------------ *
 *  Writing a call. A brand's calls live whole in the brand's own
 *  database (phase 2a of docs/tenant-db-expansion-plan.md), so every
 *  write goes there — never to the control plane, not even briefly. A
 *  residency promise kept a few milliseconds late is not kept: the write
 *  would already be in the wrong region's WAL, backups and replicas.
 *
 *  The one thing the control plane keeps is `call_shares`: which brand's
 *  database a public share slug points into, because the public page is
 *  served from the platform's host and cannot tell from the request.
 * ------------------------------------------------------------------ */

export interface CallKey {
  id: string;
  createdAt: Date;
}

/**
 * Record a call in the brand's database.
 *
 * Callers still build the payload with the control plane's types (which is
 * where the enums live for them); `brandId` is dropped, because the database
 * IS the brand. Throws if the brand's database is not ready — a customer
 * always has a brand, and a call has nowhere else to go.
 */
export async function createCall(
  brandId: string | null | undefined,
  data: TenantPrisma.CallLogUncheckedCreateInput & { brandId?: string | null },
) {
  const db = await callDb(brandId);
  const { brandId: _dropped, ...row } = data;
  const call = await db.callLog.create({
    data: row,
  });
  if (call.publicId) {
    // Minted with the call, so the shared page can find it later. brandId is a
    // string here: callDb would have thrown otherwise.
    await prisma.callShare.upsert({
      where: { publicId: call.publicId },
      create: {
        publicId: call.publicId,
        brandId: brandId!,
        callId: call.id,
        callCreatedAt: call.createdAt,
        expiresAt: call.shareExpiresAt,
      },
      update: {
        brandId: brandId!,
        callId: call.id,
        callCreatedAt: call.createdAt,
        expiresAt: call.shareExpiresAt,
      },
    });
  }
  return call;
}

/** Update one call, by its full partitioned key, in the brand's database. */
export async function updateCall(
  brandId: string | null | undefined,
  key: CallKey,
  data: TenantPrisma.CallLogUpdateInput,
) {
  const db = await callDb(brandId);
  return db.callLog.update({ where: { id_createdAt: key }, data });
}
