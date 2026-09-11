/* ------------------------------------------------------------------ *
 *  A tiny in-process cache with a time-to-live.
 *
 *  For the handful of lookups every authenticated request repeats —
 *  which departments this staff member holds, say — where the answer
 *  changes rarely and a few seconds of staleness is acceptable, but a
 *  database round trip per request is not. On a remote database each of
 *  those costs 100-300ms, and one screen load makes five or six at once.
 *
 *  Single-process by design: nothing here is shared between instances.
 *  That is fine because entries expire on their own within seconds, and
 *  the writers that matter call `clear()` explicitly so their own change
 *  is visible at once.
 * ------------------------------------------------------------------ */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(private readonly ttlMs: number) {}

  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  /** Stores and returns `value`, so a miss reads `return cache.set(k, v)`. */
  set(key: string, value: V): V {
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    // Keep the map from growing without bound under many distinct keys.
    if (this.entries.size > 5000) this.prune();
    return value;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}
