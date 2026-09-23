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
  /** An incoming ticket call. One at a time — a newer ring replaces an older one;
   *  answering, declining or the caller giving up clears it. */
  callInvite: CallInvite | null;
  noteCallInvite: (invite: Omit<CallInvite, "at">) => void;
  clearCallInvite: (ticketId?: string) => void;
  /** The other side hung up, declined, or gave up — the open call dialog reacts to it. */
  callEnded: CallEnded | null;
  noteCallEnded: (ended: Omit<CallEnded, "at">) => void;
}

export interface CallInvite {
  ticketId: string;
  mode: "audio" | "video";
  fromName: string;
  /** Which side is being rung — decides which API answers/declines. */
  to: "staff" | "requester";
  /** Where to open the ticket (brand-relative path with ?ticket=…). */
  link: string;
  at: number;
}

export interface CallEnded {
  ticketId: string;
  reason: string;
  fromName: string;
  at: number;
}

export const useLiveStore = create<LiveState>((set) => ({
  tick: 0,
  lastRefresh: 0,
  bump: () => set((s) => ({ tick: s.tick + 1, lastRefresh: Date.now() })),
  typing: {},
  noteTyping: (ticketId, label) =>
    set((s) => ({ typing: { ...s.typing, [ticketId]: { label, at: Date.now() } } })),
  callInvite: null,
  noteCallInvite: (invite) => set({ callInvite: { ...invite, at: Date.now() } }),
  clearCallInvite: (ticketId) =>
    set((s) => (ticketId && s.callInvite?.ticketId !== ticketId ? {} : { callInvite: null })),
  callEnded: null,
  noteCallEnded: (ended) => set({ callEnded: { ...ended, at: Date.now() } }),
}));
