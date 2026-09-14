import { AsyncLocalStorage } from "node:async_hooks";

/** Ambient brand for the current request (async-local) so deep senders don't need a threaded brandId.
 *  Off-request (schedulers, workers) reads null = platform; pass a brand explicitly there. */
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
