import { create } from "zustand";
import type { CallMode } from "@/lib/livekit";

// The one live ticket call, app-wide. Pages start it; CallWindow (mounted in
// AppLayout) runs it, so it survives navigating away from the ticket.

export interface ActiveCall {
  ticketId: string;
  subject: string;
  otherName: string;
  mode: CallMode;
  perspective: "staff" | "requester";
  /** True when answering a ring rather than placing the call. */
  incoming: boolean;
  /** Bumps on every start so the same ticket can be called again. */
  key: number;
}

/** `full` is the centred pop-up, `max` fills the screen, `pip` is the small draggable tile. */
export type CallView = "full" | "max" | "pip";

interface CallState {
  call: ActiveCall | null;
  view: CallView;
  start: (call: Omit<ActiveCall, "key">) => void;
  end: () => void;
  setView: (view: CallView) => void;
}

let nextKey = 1;

export const useCallStore = create<CallState>((set) => ({
  call: null,
  view: "full",
  start: (call) => set({ call: { ...call, key: nextKey++ }, view: "full" }),
  end: () => set({ call: null, view: "full" }),
  setView: (view) => set({ view }),
}));
