// Tiny in-process TTL cache for per-request lookups that rarely change.
// Single-process on purpose — entries expire in seconds and writers call clear().
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
