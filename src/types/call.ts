// Call logs — every inbound call with transcript + AI analysis.

export type CallOutcome =
  | "completed"
  | "missed"
  | "failed"
  | "voicemail";

export type CallType = "Web" | "Phone";

/** Inbox category badge. Keep in sync with CALL_INTENTS in server/src/lib/callIntent.ts;
 *  "" = unclassified → no badge. */
export type CallIntent = "booking" | "lead" | "enquiry" | "support" | "spam";

export type Sentiment = "Positive" | "Neutral" | "Negative";

export interface TranscriptTurn {
  role: "agent" | "caller";
  text: string;
  /** Seconds from call start. */
  at: number;
}

export interface CallAnalysis {
  summary: string; // "Hey Boss! New call from ..." formatted
  intent: string; // e.g. "Booking Request"
  sentiment: Sentiment;
  actionItems: string[];
  /** Caller contact details Vapi extracts from real calls (see the
   *  analysisPlan in server/src/services/vapi.ts) — the basis for "leads". */
  structuredData?: { name?: string; phone?: string; email?: string };
  /** Vapi call id, persisted so the recording can be fetched on-demand later. */
  vapiCallId?: string;
}

export interface CallLog {
  id: string;
  conversionId: string;
  type: CallType;
  callerName: string;
  callerNumber: string;
  createdAt: string; // ISO
  durationSec: number;
  outcome: CallOutcome;
  summary: string; // short one-liner shown in the table
  /** What the caller wanted — booking / lead / enquiry / support / spam.
   *  "" or undefined when unclassified. */
  intent?: CallIntent | "";
  /** The team/department the caller asked to be connected to (e.g. "Sales"). */
  requestedDepartment?: string;
  /** Transfer result: "connected", "failed" (wanted a human but couldn't
   *  connect — call them back), or "" / undefined when no transfer was involved. */
  transferOutcome?: "connected" | "failed" | "";
  recordingUrl?: string;
  transcript: TranscriptTurn[];
  analysis: CallAnalysis;
  /** Transcript + analysis moved to cold storage, so the list shipped without them; opening the call
   *  fetches the rest (`useCallsStore.ensureTranscript`). */
  blobArchived?: boolean;
}
