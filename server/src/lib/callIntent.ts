/* ------------------------------------------------------------------ *
 *  Call intent — "what was this call about?"
 *
 *  Deliberately, only TWO of the five categories depend on AI judgement.
 *  Precedence, highest first — the first rule that matches wins:
 *
 *   1. booking  — a confirmed Appointment row was written during the call by the
 *                 live booking tools (and, when the owner has Google Calendar
 *                 connected, mirrored to their calendar). A FACT, never a model
 *                 opinion. DETERMINISTIC.
 *   2. spam     — the caller never said a word. DETERMINISTIC.
 *   3. spam     — wrong number / robocall / telemarketing. Model.
 *   4. support  — an EXISTING customer with a problem. Model. Outranks `lead` so
 *                 a complaint never lands in the sales pipeline just because the
 *                 caller gave their name.
 *   5. lead     — we captured a way to reach them: the caller volunteered a
 *                 name/email/callback number, or the AI asked for and got it.
 *                 DETERMINISTIC — "is this a lead?" is exactly the boundary an
 *                 LLM flip-flops on, so it is never asked.
 *   6. enquiry  — the caller spoke, but none of the above. The default.
 *   -- ""       — no transcript at all. We know nothing, so we badge nothing.
 *
 *  Three of the five are decided by facts, not judgement. Only "is this junk?"
 *  and "is this an existing customer with a problem?" go to a model, and both
 *  are things models are reliable at.
 *
 *  WHY BOOKING IS NEVER INFERRED: "I want to book a table" is not a booking.
 *  Both a keyword match on /book/ and an LLM asked "was this a booking?" fire on
 *  the caller's INTENT to book, so for a restaurant or hotel agent every single
 *  call comes out Booking. A caller who asked to book, gave their name, and was
 *  told "the team will follow up" is a LEAD — nothing is in the diary. Only a
 *  real Appointment row proves otherwise, so that is the only thing we accept.
 *
 *  IMPORTANT — what "volunteered" means: on an inbound phone call we ALWAYS have
 *  the caller's number from caller ID, so "we have a phone number" would make
 *  every call a lead. Only `analysis.structuredData` (what the assistant heard
 *  the caller say) counts; `customer.number` does not. See callerContactCaptured.
 * ------------------------------------------------------------------ */

/** The closed set of intents. Stored as a plain string column (not a DB enum)
 *  so a future category needs no migration and an unknown model output can be
 *  normalised away instead of blowing up the write. */
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

/* ------------------------------------------------------------------ *
 *  The deterministic half: did the caller hand us a way to reach them?
 * ------------------------------------------------------------------ */

/** A field counts only if it holds something real — the extraction model writes
 *  "", "unknown", "n/a" etc. when the caller never said it. */
function said(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim().toLowerCase();
  if (v.length < 2) return false;
  return !["unknown", "none", "n/a", "na", "null", "not provided", "not given", "-"].includes(v);
}

/**
 * True when the caller VOLUNTEERED contact details during the conversation.
 *
 * Pass ONLY `analysis.structuredData` here. Never pass the caller-ID number:
 * inbound calls always carry one, so including it would mark every call a lead
 * and make the badge meaningless.
 */
/**
 * Did the CALLER actually say anything?
 *
 * An agent-only transcript ("Thanks for calling… How can I help you today?"
 * then silence) is not an enquiry — nobody asked anything. Note that the AI
 * summary cannot be used to decide this: handed an agent-only transcript it
 * will happily write "the caller inquired about our services", inventing a
 * caller who never spoke. Only real caller turns count.
 */
export function callerSpoke(callerText?: string | null): boolean {
  const t = (callerText ?? "").trim();
  // Strip punctuation so a stray "…" or "?" doesn't read as speech.
  return t.replace(/[^\p{L}\p{N}]/gu, "").length > 0;
}

export function callerContactCaptured(structured: unknown): boolean {
  if (!structured || typeof structured !== "object") return false;
  const s = structured as Record<string, unknown>;
  return said(s.name) || said(s.email) || said(s.phone);
}

/* ------------------------------------------------------------------ *
 *  Keyword heuristic — fallback for the AI-judged categories only
 * ------------------------------------------------------------------ */

/** Covers `support` and `spam` ONLY.
 *
 *  There is deliberately no `booking` rule: booking-intent words ("book",
 *  "appointment", "slot") appear in every call to a business that takes
 *  bookings, including the ones where nothing was ever booked. A booking is
 *  proven by an Appointment row, not by vocabulary.
 *
 *  `lead` and `enquiry` are likewise never guessed — the contact-capture rule
 *  decides those. Ordered most-specific-first; the first match wins. */
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

/**
 * Best-effort keyword read of a call's text, for the AI-judged categories only.
 * Returns "" when nothing matches — the caller then falls back to the
 * deterministic lead/enquiry rule rather than guessing.
 */
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

/**
 * Resolve the final stored intent from every available signal, applying the
 * precedence documented at the top of this file.
 *
 * `structured` must be the assistant's extracted structuredData — NOT the
 * caller-ID number (see callerContactCaptured).
 */
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
  // 1. A confirmed appointment is proof, and outranks every opinion. This is the
  //    ONLY way a call becomes "booking".
  if (input.bookingConfirmed) return "booking";

  // 2. Silence is spam. If we HAVE a transcript but the caller never said a
  //    word, there is nothing to answer, follow up, or file.
  //
  //    Two guards, both deliberate:
  //     - the transcript must exist. A call logged without one tells us nothing,
  //       and "no data" must never be reported as "junk".
  //     - callerText must have been SUPPLIED (undefined ≠ ""). A caller who said
  //       nothing is silence; a caller whose words we were never handed is
  //       unknown. Without this, one call site forgetting the field would badge
  //       every call spam and suppress every lead.
  const transcriptPresent = Boolean(input.transcript?.trim());
  const callerTextKnown = input.callerText !== undefined && input.callerText !== null;
  const spoke = callerSpoke(input.callerText);
  if (transcriptPresent && callerTextKnown && !spoke) return "spam";

  // The AI-judged half: whichever source we have, normalised to our set.
  const judged =
    normalizeIntent(input.structuredIntent) ||
    normalizeIntent(input.llmIntent) ||
    classifyIntentHeuristic(input);

  // 3. Wrong number / robocall / telemarketing — the model's read, plus the
  //    keyword fallback. ONLY spam and support are taken from the model: a model
  //    saying "lead" or "enquiry" is ignored (that call is ours to decide,
  //    deterministically), and a model saying "booking" is ignored too — it
  //    means the caller TALKED about booking, which is not the same as booking.
  if (judged === "spam") return "spam";

  // 4. An existing customer with a problem. Above `lead` so a complaint never
  //    lands in the sales pipeline just because they gave their name.
  if (judged === "support") return "support";

  // 5. Did they leave us a way to follow up? Either they volunteered it or the
  //    AI asked for it. Phone calls get this from structuredData; web/test calls
  //    have none, so `contactCaptured` carries the same fact read straight from
  //    the transcript. Either source is enough.
  if (input.contactCaptured || callerContactCaptured(input.structured)) return "lead";

  // 6. Everything else the caller actually said is a general enquiry. With no
  //    transcript at all we know nothing, so we badge nothing.
  return spoke ? "enquiry" : "";
}
