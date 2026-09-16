import { create } from "zustand";

/** Global live heartbeat — useLiveData bumps `tick` on an interval and on tab focus. Shared
 *  stores re-hydrate each cycle; pages that fetch their own data add useLiveTick() to their deps. */
interface LiveState {
  /** Monotonic counter, incremented once per live refresh cycle. */
  tick: number;
  /** Epoch ms of the last refresh — for "updated Xs ago" style affordances. */
  lastRefresh: number;
  bump: () => void;
  /** "Someone is typing", per ticket id — the one pushed event with a payload, since a
   *  keystroke is never stored to re-fetch. Entries are timestamped, not cleared; stale = expired. */
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
