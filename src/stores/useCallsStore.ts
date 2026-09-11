import { create } from "zustand";
import type { CallIntent, CallLog, CallAnalysis, Sentiment, TranscriptTurn } from "@/types";
import { api } from "@/lib/api";
import { sessionMark, sessionChanged } from "@/lib/sessionEpoch";

const SENTIMENTS: Sentiment[] = ["Positive", "Neutral", "Negative"];

/** Coerce a raw `analysis` blob (real calls carry Vapi's shape, which lacks
 *  intent/sentiment/actionItems) into the app's `CallAnalysis` so consumers can
 *  read `.actionItems.length` etc. without guarding every access. */
function normalizeAnalysis(raw: unknown, fallbackSummary: string): CallAnalysis {
  const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const sd = (a.structuredData && typeof a.structuredData === "object"
    ? a.structuredData
    : {}) as Record<string, unknown>;
  return {
    summary: typeof a.summary === "string" ? a.summary : fallbackSummary,
    intent: typeof a.intent === "string" ? a.intent : "—",
    sentiment: SENTIMENTS.includes(a.sentiment as Sentiment) ? (a.sentiment as Sentiment) : "Neutral",
    actionItems: Array.isArray(a.actionItems)
      ? (a.actionItems.filter((x) => typeof x === "string") as string[])
      : [],
    structuredData: {
      name: typeof sd.name === "string" ? sd.name : undefined,
      phone: typeof sd.phone === "string" ? sd.phone : undefined,
      email: typeof sd.email === "string" ? sd.email : undefined,
    },
    vapiCallId: typeof a.vapiCallId === "string" ? a.vapiCallId : undefined,
  };
}

/** Real phone calls store the transcript as Vapi's plain string ("AI: …\nUser: …");
 *  parse it into turns. Web test calls already send a structured array. */
function normalizeTranscript(raw: unknown): TranscriptTurn[] {
  if (Array.isArray(raw)) {
    return raw
      .map((t) => {
        const o = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
        return {
          role: o.role === "caller" ? "caller" : "agent",
          text: typeof o.text === "string" ? o.text : "",
          at: typeof o.at === "number" ? o.at : 0,
        } as TranscriptTurn;
      })
      .filter((t) => t.text.trim().length > 0);
  }
  if (typeof raw === "string") {
    return raw
      .split("\n")
      .map((line) => {
        const m = line.match(/^\s*(\w+)\s*:\s*(.*)$/);
        const speaker = (m?.[1] ?? "").toLowerCase();
        const role: TranscriptTurn["role"] =
          speaker.includes("user") || speaker.includes("caller") || speaker.includes("customer")
            ? "caller"
            : "agent";
        return { role, text: m ? m[2] : line, at: 0 };
      })
      .filter((t) => t.text.trim().length > 0);
  }
  return [];
}

/** Defensive boundary normalizer — backend call logs (especially real phone
 *  calls) don't perfectly match the frontend `CallLog` shape. */
function normalizeCallLog(raw: CallLog): CallLog {
  return {
    ...raw,
    callerName: raw.callerName || "A caller",
    summary: raw.summary || "",
    transcript: normalizeTranscript(raw.transcript),
    analysis: normalizeAnalysis(raw.analysis, raw.summary || ""),
  };
}

interface CallsState {
  calls: CallLog[];
  selectedId: string | null;
  /** False until the first hydrate resolves — drives loading skeletons. */
  loaded: boolean;
  hydrate: () => Promise<void>;
  /** Prepend new call logs (newest first). Used by the Quick Setup test flow. */
  addCalls: (calls: CallLog[]) => void;
  select: (id: string | null) => void;
  /** Pull an archived call's transcript + analysis back from cold storage.
   *
   *  Calls past the archive window ship from the list without their blobs — the
   *  alternative was one cold-storage read per row for a 500-row page, to fill
   *  fields the table never renders. So the panel and the copy action fetch the
   *  single call the owner actually opened. A no-op (and no request) for a call
   *  that still carries its transcript inline, which is nearly all of them. */
  ensureTranscript: (id: string) => Promise<CallLog | null>;
  /** Owner-corrected category. Applied optimistically, then persisted; on
   *  failure the previous value is restored so the UI never lies. */
  setIntent: (id: string, intent: CallIntent) => Promise<void>;
  reset: () => void;
}

// Call logs are NOT persisted to localStorage — they're always hydrated fresh
// from the API. Persisting them risked showing stale data when a hydrate failed.
export const useCallsStore = create<CallsState>((set, get) => ({
  calls: [],
  selectedId: null,
  loaded: false,
  hydrate: async () => {
    const mark = sessionMark();
    try {
      const data = await api.calls.list({ pageSize: 500 });
      if (sessionChanged(mark)) return; // response belongs to a previous account
      set({ calls: data.calls.map(normalizeCallLog) });
    } catch {
      /* never throw out of hydrate */
    } finally {
      if (!sessionChanged(mark)) set({ loaded: true });
    }
  },
  addCalls: (incoming) =>
    set((s) => {
      const existing = new Set(s.calls.map((c) => c.id));
      const fresh = incoming.map(normalizeCallLog).filter((c) => !existing.has(c.id));
      return {
        calls: [...fresh, ...s.calls].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        ),
      };
    }),
  select: (id) => set({ selectedId: id }),
  // Reads through zustand's own `get`, not `useCallsStore.getState()`: this one
  // returns a value derived from the state, and referring to the store by name
  // inside its own initializer makes that return type circular.
  ensureTranscript: async (id) => {
    const current = get().calls.find((c) => c.id === id) ?? null;
    if (!current?.blobArchived) return current;
    try {
      const full = normalizeCallLog(await api.calls.get(id));
      set((s) => ({ calls: s.calls.map((c) => (c.id === id ? full : c)) }));
      return full;
    } catch {
      // Cold storage is unreachable or the object is gone. Keep the row we have
      // — every field the table shows is still correct; only the transcript is
      // missing, and the panel already renders that case.
      return current;
    }
  },
  setIntent: async (id, intent) => {
    const previous = useCallsStore.getState().calls.find((c) => c.id === id)?.intent;
    const apply = (value: CallLog["intent"]) =>
      set((s) => ({ calls: s.calls.map((c) => (c.id === id ? { ...c, intent: value } : c)) }));
    apply(intent);
    try {
      await api.calls.setIntent(id, intent);
    } catch (err) {
      apply(previous);
      throw err;
    }
  },
  reset: () => set({ calls: [], selectedId: null, loaded: false }),
}));
