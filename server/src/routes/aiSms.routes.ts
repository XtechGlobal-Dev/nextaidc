import express from "express";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { asyncHandler } from "../lib/http.js";
import { parseToolCalls, toolArgBoolean, toolArgString } from "../lib/vapiToolCalls.js";
import { getSmsInfoConfig, resolveSmsInfoTopics, type SmsInfoEntry } from "../services/smsInfo.js";
import { buildCombinedSmsBody } from "../lib/smsInfoItems.js";
import { isTwilioConfigured, textCallerInfo } from "../services/sms.js";
import { getPlanFeatures } from "../services/trial.js";

/* ------------------------------------------------------------------ *
 *  "Text Info to Callers" dispatcher (PUBLIC — Vapi posts here mid-call, no
 *  auth). The owning business comes from `?uid=<userId>` stamped on the tool
 *  URL, exactly like the booking dispatcher.
 *
 *  The assistant only ever names a `topic`. The message body is resolved here
 *  from the owner's own template, so no amount of caller persuasion can make the
 *  agent text arbitrary content from the business's number. Every tool call
 *  answers with a short string that gets spoken back into the conversation.
 * ------------------------------------------------------------------ */

const router = express.Router();

/** Most a single call may send. A caller asking for the website, the email and
 *  the address is legitimate; a caller trying to make us an SMS gateway is not. */
const MAX_SENDS_PER_CALL = 3;
/** Most one destination number may receive across all calls in a rolling day. */
const MAX_SENDS_PER_NUMBER_DAY = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How long a call's send history is remembered. Comfortably longer than any
 *  call, short enough that the map can't grow without bound. */
const CALL_TTL_MS = 60 * 60 * 1000;

interface CallState {
  /** Topics already sent on this call — the idempotency key. Vapi retries tool
   *  calls, and a retry must never bill (or text) the caller twice. */
  sent: Set<string>;
  count: number;
  expiresAt: number;
}

// In-memory, single-process — same trade-off as middleware/rateLimit.ts. Losing
// this on restart is harmless: the worst case is a caller could be texted the
// same detail twice across a process boundary mid-call.
const callState = new Map<string, CallState>();
const numberState = new Map<string, { count: number; resetAt: number }>();

/** Drop expired entries so a long-lived process doesn't accumulate dead calls. */
function prune(now: number): void {
  for (const [k, v] of callState) if (v.expiresAt <= now) callState.delete(k);
  for (const [k, v] of numberState) if (v.resetAt <= now) numberState.delete(k);
}

function getCallState(callId: string, now: number): CallState {
  const existing = callState.get(callId);
  if (existing && existing.expiresAt > now) return existing;
  const fresh: CallState = { sent: new Set(), count: 0, expiresAt: now + CALL_TTL_MS };
  callState.set(callId, fresh);
  return fresh;
}

/** True when this destination is still under its rolling-day allowance. Only
 *  called once we're about to actually send, so a refused send costs nothing. */
function takeNumberQuota(phone: string, now: number): boolean {
  const entry = numberState.get(phone);
  if (!entry || entry.resetAt <= now) {
    numberState.set(phone, { count: 1, resetAt: now + DAY_MS });
    return true;
  }
  if (entry.count >= MAX_SENDS_PER_NUMBER_DAY) return false;
  entry.count += 1;
  return true;
}

/**
 * Resolve the destination number to E.164.
 *
 * The caller's ANI is the trusted default — it's the number they're actually on.
 * A number the model transcribed from speech is only used when it parses to a
 * valid number, and it's parsed in the ANI's country so a locally-spoken number
 * ("oh four one two...") resolves correctly. Anything questionable falls back to
 * the ANI rather than texting a stranger.
 */
export function resolveDestination(spoken: string, callerNumber: string): string {
  const ani = callerNumber.trim();
  const said = spoken.trim();
  if (!said) return ani;
  const region = ani ? parsePhoneNumberFromString(ani)?.country : undefined;
  const parsed = parsePhoneNumberFromString(said, region);
  if (parsed?.isValid()) return parsed.number;
  return ani;
}

/** The topics a sendInfoSms call is asking for. Accepts the `topics` array the
 *  tool advertises, and tolerates a lone `topic` string in case the model emits
 *  the singular form. De-duplicated, in ask order. */
export function parseTopics(args: Record<string, unknown>): string[] {
  const raw = Array.isArray(args.topics) ? args.topics : [];
  // Only strings are valid topic keys — a number or object is malformed model
  // output, not a topic, so drop it rather than stringifying it into a miss.
  const list = raw.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean);
  const single = toolArgString(args.topic);
  if (single) list.push(single);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of list) {
    const k = t.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  return out;
}

/** How the assistant refers to what it's about to send, when speaking back. */
function spokenLabel(entries: SmsInfoEntry[]): string {
  if (entries.length === 1) return `the ${entries[0].item.label.toLowerCase()}`;
  return "those details";
}

/** Run one sendInfoSms call and return the string the assistant speaks. */
async function runSendInfoSms(
  uid: string,
  callId: string,
  callerNumber: string,
  args: Record<string, unknown>,
): Promise<string> {
  // Plan gate, checked HERE and not only where the tool is attached. This
  // endpoint is an unauthenticated Vapi webhook keyed on `uid`, so it is the
  // last line before we actually spend money on an SMS: anyone who flipped the
  // switch on past a disabled control (or posts here directly) still can't send.
  if (!(await getPlanFeatures(uid)).smsToCaller) {
    return "I can't text that through right now, but I'm happy to give you the details over the phone.";
  }
  const config = await getSmsInfoConfig(uid);
  if (!config.enabled) {
    return "I can't text that through right now, but I'm happy to give you the details over the phone.";
  }

  const topics = parseTopics(args);
  if (!topics.length) {
    return "Which detail would you like me to text you?";
  }
  const entries = resolveSmsInfoTopics(config, topics);
  if (!entries.length) {
    return "I don't have that one to send, but I can tell you over the phone if you'd like.";
  }

  // Consent is the whole point of the offer-then-send flow — if the assistant
  // fired the tool without asking, don't send. Speaking this back nudges it to
  // ask properly, and the caller only ever hears a natural-sounding question.
  if (!toolArgBoolean(args.consentGiven)) {
    return `Before I send that — would you like me to text you ${spokenLabel(entries)}?`;
  }

  const now = Date.now();
  prune(now);
  const state = getCallState(callId || `anon:${callerNumber}`, now);

  // Vapi retries tool calls, and callers repeat themselves — so only send the
  // details we haven't already texted on this call. If they're all sent, say so
  // rather than texting (and billing) the same thing twice.
  const fresh = entries.filter((e) => !state.sent.has(e.item.key));
  if (!fresh.length) {
    return "That's already on its way to you — it should land in a moment.";
  }
  if (state.count >= MAX_SENDS_PER_CALL) {
    return "I've sent you a few texts already — I'll go through the rest over the phone instead.";
  }

  // Everything the caller asked for goes in ONE message — a single SMS, a single
  // charge — even when they asked for several things at once.
  const body =
    fresh.length === 1
      ? fresh[0].body
      : buildCombinedSmsBody(fresh.map((e) => e.item), config.values, config.businessName);

  const to = resolveDestination(toolArgString(args.phone), callerNumber);
  if (!to) {
    return "I don't have a mobile number to text — what's the best number for you?";
  }
  if (!isTwilioConfigured()) {
    return `I can't send texts at the moment, but here it is: ${body}`;
  }
  if (!takeNumberQuota(to, now)) {
    return "That number's had a lot of texts from us today, so I'll give you the details over the phone instead.";
  }

  const sent = await textCallerInfo(to, body, uid);
  if (!sent) {
    // The text didn't go — read the detail out rather than leaving the caller
    // waiting for a message that will never arrive.
    return `I couldn't get that text to send, but here it is: ${body}`;
  }

  fresh.forEach((e) => state.sent.add(e.item.key));
  state.count += 1;
  return `Done — I've texted ${spokenLabel(fresh)} to you. It should arrive in a few seconds.`;
}

// Vapi posts every sendInfoSms call here. Responds with
// { results: [{ toolCallId, result }] } — each string is spoken back.
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const uid = String(req.query.uid || "").trim();
    const { calls, callerNumber, callId } = parseToolCalls(req.body);
    if (!uid || !calls.length) {
      res.json({ results: [] });
      return;
    }
    const results = [];
    for (const c of calls) {
      let result: string;
      try {
        result =
          c.name === "sendInfoSms"
            ? await runSendInfoSms(uid, callId, callerNumber, c.args)
            : "Sorry, I couldn't do that.";
      } catch (e) {
        console.error(`[infoSms] tool ${c.name} failed for uid ${uid}:`, e);
        result = "Sorry, something went wrong on my end.";
      }
      results.push({ toolCallId: c.id, result });
    }
    res.json({ results });
  }),
);

export default router;
