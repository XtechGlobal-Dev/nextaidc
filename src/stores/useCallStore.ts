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
  /** True when this window is coming back to a call it was already on (the tab was refreshed). */
  rejoin?: boolean;
  /** Bumps on every start so the same ticket can be called again. */
  key: number;
}


/** `full` is the centred pop-up, `max` fills the screen, `pip` is the small draggable tile. */
export type CallView = "full" | "max" | "pip";

interface CallState {
  call: ActiveCall | null;
  /** True from start until the call finishes (the window may linger a moment after). A ring for
   *  a ticket this window is live on is ignored — answering it would only kick this session. */
  live: boolean;
  view: CallView;
  /** Which ticket's conversation is on the page right now (CallChatSlot says). The call's Chat
   *  panel can only show a thread that a page is holding. */
  chatSlot: string | null;
  /** The call window's open Chat panel — the page portals its thread and composer in here. */
  chatHost: HTMLElement | null;
  start: (call: Omit<ActiveCall, "key">) => void;
  markEnded: () => void;
  end: () => void;
  /** Picks the call back up after a page refresh. Returns whether there was one to resume. */
  resume: () => boolean;
  setView: (view: CallView) => void;
  setChatSlot: (ticketId: string | null) => void;
  setChatHost: (el: HTMLElement | null) => void;
}

let nextKey = 1;

// A refresh must not hang up: the live call is noted in sessionStorage, which survives a reload of
// this tab and nothing else — closing the tab really does leave the call.
const STORAGE_KEY = "hello22_call";
type StoredCall = Pick<ActiveCall, "ticketId" | "subject" | "otherName" | "mode" | "perspective">;

function remember(call: StoredCall) {
  try {
    const { ticketId, subject, otherName, mode, perspective } = call;
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ticketId, subject, otherName, mode, perspective }));
  } catch {
    // Storage blocked: the call still works, it just won't survive a refresh.
  }
}

function forget() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to forget.
  }
}

function recall(): StoredCall | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Partial<StoredCall>;
    if (typeof c.ticketId !== "string" || typeof c.otherName !== "string") return null;
    return {
      ticketId: c.ticketId,
      subject: typeof c.subject === "string" ? c.subject : "",
      otherName: c.otherName,
      mode: c.mode === "video" ? "video" : "audio",
      perspective: c.perspective === "staff" ? "staff" : "requester",
    };
  } catch {
    return null;
  }
}

export const useCallStore = create<CallState>((set, get) => ({
  call: null,
  live: false,
  view: "full",
  chatSlot: null,
  chatHost: null,
  start: (call) => {
    remember(call);
    set({ call: { ...call, key: nextKey++ }, live: true, view: "full" });
  },
  markEnded: () => {
    forget();
    set({ live: false });
  },
  end: () => {
    forget();
    set({ call: null, live: false, view: "full", chatHost: null });
  },
  resume: () => {
    if (get().call) return false;
    const saved = recall();
    if (!saved) return false;
    get().start({ ...saved, incoming: true, rejoin: true });
    return true;
  },
  setView: (view) => set({ view }),
  setChatSlot: (ticketId) => set({ chatSlot: ticketId }),
  setChatHost: (el) => set({ chatHost: el }),
}));
