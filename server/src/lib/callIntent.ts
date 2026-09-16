// Intent precedence: booking (real Appointment row only — talking about booking isn't booking) > silent spam >
// model spam > model support > lead (contact captured, never model-judged) > enquiry. Caller-ID never counts as captured.

/** Stored as a plain string column, not a DB enum, so new categories need no migration. */
export const CALL_INTENTS = ["booking", "lead", "enquiry", "support", "spam"] as const;

export type CallIntent = (typeof CALL_INTENTS)[number];
/** "" = not classified (rows logged before this feature) → no badge. */
export type CallIntentValue = CallIntent | "";

/** Synonyms the LLM (or a future caller) might hand us for each intent. */
const SYNONYMS: Record<string, CallIntent> = {
  booking: "booking",
  book: "booking",
  appointment: "booking",
  reschedule: "booking",
  cancellation: "booking",
  schedule: "booking",

  lead: "lead",
  new_lead: "lead",
  newlead: "lead",
  quote: "lead",
  sales: "lead",
  prospect: "lead",

  enquiry: "enquiry",
  inquiry: "enquiry",
  question: "enquiry",
  info: "enquiry",
  information: "enquiry",
  general: "enquiry",

  support: "support",
  complaint: "support",
  issue: "support",
  problem: "support",
  service: "support",
  existing_customer: "support",

  spam: "spam",
  robocall: "spam",
  telemarketing: "spam",
  wrong_number: "spam",
};

/** Coerce any raw value into a known intent, or "" when it isn't one. */
export function normalizeIntent(raw: unknown): CallIntentValue {
  if (typeof raw !== "string") return "";
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!key) return "";
  if ((CALL_INTENTS as readonly string[]).includes(key)) return key as CallIntent;
  return SYNONYMS[key] ?? "";
}

// The deterministic half: did the caller hand us a way to reach them?

/** A field counts only if it holds something real — the extraction model writes
 *  "", "unknown", "n/a" etc. when the caller never said it. */
function said(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim().toLowerCase();
  if (v.length < 2) return false;
  return !["unknown", "none", "n/a", "na", "null", "not provided", "not given", "-"].includes(v);
}

/** Did the caller actually say anything? Don't use the AI summary for this — handed an agent-only
 *  transcript it invents a caller who never spoke. */
export function callerSpoke(callerText?: string | null): boolean {
  const t = (callerText ?? "").trim();
  // Strip punctuation so a stray "…" or "?" doesn't read as speech.
  return t.replace(/[^\p{L}\p{N}]/gu, "").length > 0;
}

/** Pass only `analysis.structuredData` — never the caller-ID number, or every inbound call is a lead. */
export function callerContactCaptured(structured: unknown): boolean {
  if (!structured || typeof structured !== "object") return false;
  const s = structured as Record<string, unknown>;
  return said(s.name) || said(s.email) || said(s.phone);
}

// Keyword fallback for the AI-judged categories (support, spam) only. No booking rule on purpose:
// booking words appear in every call to a business that takes bookings. First match wins.
const RULES: { intent: CallIntent; re: RegExp }[] = [
  {
    intent: "spam",
    re: /\b(wrong number|not interested|remove me|stop calling|telemarket|robocall|survey call|marketing call)\b/i,
  },
  {
    intent: "support",
    re: /\b(complain|complaint|not working|broken|faulty|refund|late delivery|still waiting|existing (customer|order)|my order|order number|chase up|follow(ing)? up on my)\b/i,
  },
];

/** Keyword read for the AI-judged categories; "" when nothing matches so the deterministic rules decide. */
export function classifyIntentHeuristic(input: {
  purpose?: string | null;
  summary?: string | null;
  transcript?: string | null;
}): CallIntentValue {
  // Purpose + summary first (short, high signal), then the whole transcript.
  const strong = `${input.purpose ?? ""}\n${input.summary ?? ""}`.trim();
  const full = `${strong}\n${input.transcript ?? ""}`.trim();
  if (!full) return "";

  for (const source of [strong, full]) {
    if (!source) continue;
    for (const rule of RULES) {
      if (rule.re.test(source)) return rule.intent;
    }
  }
  return "";
}

/** Final intent per the precedence at the top of the file. `structured` must be extracted
 *  structuredData, never the caller-ID number. */
export function resolveIntent(input: {
  /** True only when a confirmed Appointment row was written during this call.
   *  Never inferred from what was said — see the note at the top of the file. */
  bookingConfirmed?: boolean;
  /** Vapi's extracted `structuredData.intent` (free — no extra LLM call). */
  structuredIntent?: unknown;
  /** OpenAI's classification, used only where structuredData is absent. */
  llmIntent?: unknown;
  /** The assistant's extracted structuredData, for the contact-capture rule. */
  structured?: unknown;
  /** Contact-capture read from the transcript, for calls that carry no
   *  structuredData (web/test calls). ORed with the structuredData rule. */
  contactCaptured?: boolean;
  purpose?: string | null;
  summary?: string | null;
  transcript?: string | null;
  /** Only what the CALLER said. Gates the `enquiry` default — see callerSpoke. */
  callerText?: string | null;
}): CallIntentValue {
  // 1. The only way a call becomes "booking".
  if (input.bookingConfirmed) return "booking";

  // 2. Silence is spam — but only when we have a transcript AND callerText was supplied
  //    (undefined ≠ ""). Otherwise "no data" would be reported as junk and leads suppressed.
  const transcriptPresent = Boolean(input.transcript?.trim());
  const callerTextKnown = input.callerText !== undefined && input.callerText !== null;
  const spoke = callerSpoke(input.callerText);
  if (transcriptPresent && callerTextKnown && !spoke) return "spam";

  // The AI-judged half: whichever source we have, normalised to our set.
  const judged =
    normalizeIntent(input.structuredIntent) ||
    normalizeIntent(input.llmIntent) ||
    classifyIntentHeuristic(input);

  // 3. Only spam and support are taken from the model; its "lead"/"enquiry"/"booking" are ignored
  //    (a model "booking" just means the caller talked about booking).
  if (judged === "spam") return "spam";

  // 4. Above `lead` so a complaint never lands in the sales pipeline because they gave a name.
  if (judged === "support") return "support";

  // 5. structuredData for phone calls; `contactCaptured` carries the same fact for web/test calls.
  if (input.contactCaptured || callerContactCaptured(input.structured)) return "lead";

  // 6. No transcript at all → we know nothing, badge nothing.
  return spoke ? "enquiry" : "";
}
