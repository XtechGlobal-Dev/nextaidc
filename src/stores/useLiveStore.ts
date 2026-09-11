import { create } from "zustand";

/**
 * Global "live" heartbeat. A single driver ({@link useLiveData}) bumps `tick`
 * on a short interval (and instantly on tab focus) while the user is signed in.
 *
 * Two ways to consume it:
 *  - Customer-facing pages read from the shared data stores (calls, CRM, trial,
 *    usage), which the driver re-hydrates each cycle — so they update with no
 *    page changes at all.
 *  - Pages that fetch their own data (most Admin screens) subscribe to `tick`
 *    via {@link useLiveTick} and add it to their loader effect's deps, so the
 *    loader re-runs every cycle without a manual reload.
 */
interface LiveState {
  /** Monotonic counter, incremented once per live refresh cycle. */
  tick: number;
  /** Epoch ms of the last refresh — for "updated Xs ago" style affordances. */
  lastRefresh: number;
  bump: () => void;
  /**
   * "Someone is typing", per ticket id.
   *
   * The only pushed event whose PAYLOAD matters. Everything else is a "something
   * changed" tag the pages answer by re-fetching, but there is nothing to fetch
   * for a keystroke — it is never written down. Entries are stamped rather than
   * cleared on a timer, so a stale one simply reads as expired.
   */
  typing: Record<string, { label: string; at: number }>;
  noteTyping: (ticketId: string, label: string) => void;
}

export const useLiveStore = create<LiveState>((set) => ({
  tick: 0,
  lastRefresh: 0,
  bump: () => set((s) => ({ tick: s.tick + 1, lastRefresh: Date.now() })),
  typing: {},
  noteTyping: (ticketId, label) =>
    set((s) => ({ typing: { ...s.typing, [ticketId]: { label, at: Date.now() } } })),
}));
