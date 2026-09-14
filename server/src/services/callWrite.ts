import type { Prisma as TenantPrisma } from "@prisma/tenant-client";
import { prisma } from "../prisma.js";
import { callDb } from "./tenantDb.js";

// Calls are written only to the brand's database — never the control plane, not even briefly (residency:
// it'd already be in the wrong region's WAL). The control plane keeps just call_shares, mapping a public slug to its brand.

export interface CallKey {
  id: string;
  createdAt: Date;
}

/** Records a call in the brand's database. `brandId` is dropped (the database IS the brand); throws if the tenant DB isn't ready — a call has nowhere else to go. */
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
