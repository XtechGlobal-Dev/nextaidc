// Monotonic session counter, bumped on every account change via resetUserStores(). A hydrate/poll fired
// under account A can resolve after B signs in and flash A's data; snapshot sessionMark() before the await, drop the write if sessionChanged().
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
