import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The brand (tenant) the CURRENT request belongs to, carried implicitly.
 *
 * Why not thread a brandId parameter through every call? The senders that need
 * it — email, SMS, WhatsApp — sit five or six frames below the route, behind
 * services that have nothing to do with tenancy. Async-local storage lets the
 * one middleware that resolves the host set it once, and lets the sender read
 * it at the bottom, without rewriting everything in between.
 *
 * Outside a request (schedulers, webhook workers, CLI scripts) the store is
 * empty and every read returns null — which resolves to the platform's own
 * settings, i.e. exactly the behaviour that existed before brands. Anything
 * running off-request that needs a brand must pass one explicitly (see
 * `brandIdForUser`).
 */
export interface BrandContext {
  brandId: string | null;
}

const storage = new AsyncLocalStorage<BrandContext>();

/** Run `fn` with the given brand as the ambient tenant. */
export function runWithBrand<T>(brandId: string | null, fn: () => T): T {
  return storage.run({ brandId }, fn);
}

/** The ambient brand id, or null outside a branded request. */
export function currentBrandId(): string | null {
  return storage.getStore()?.brandId ?? null;
}

/** Replace the ambient brand mid-request — used once the authenticated user is
 *  known, since their own brand beats whatever host they happened to call. */
export function setCurrentBrandId(brandId: string | null): void {
  const store = storage.getStore();
  if (store) store.brandId = brandId;
}
