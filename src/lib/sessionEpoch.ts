/**
 * A monotonic counter that identifies the CURRENT signed-in session. It bumps
 * on every account change — login, logout, and admin impersonation enter/exit —
 * via resetUserStores().
 *
 * Why it exists: a store's async `hydrate()` (or a background poll / SSE refresh)
 * can be fired under account A, then resolve AFTER account B has signed in on the
 * same tab. Without a guard, A's response lands in B's freshly-reset store and
 * the UI flashes A's data for a second or two until B's own hydrate overwrites it.
 *
 * Usage: snapshot the epoch before the request, then drop the write if it changed
 * by the time the response arrives —
 *
 *   hydrate: async () => {
 *     const mark = sessionMark();
 *     const data = await api.thing.get();
 *     if (sessionChanged(mark)) return; // response belongs to a previous account
 *     set({ ... });
 *   }
 */
let epoch = 0;

/** Advance to a new session. Called by resetUserStores() on every account change. */
export function bumpSession(): void {
  epoch += 1;
}

/** Snapshot the current session, to be checked after an await. */
export function sessionMark(): number {
  return epoch;
}

/** True once the account has changed since `mark` was taken — the caller's
 *  in-flight response is stale and must not be applied. */
export function sessionChanged(mark: number): boolean {
  return mark !== epoch;
}
