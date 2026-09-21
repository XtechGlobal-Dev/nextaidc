import { notImplemented, HttpError } from "../lib/http.js";
import { compileMasterPrompt, compileLanguagesSection, resolveGreeting, sanitizeAgentLanguages, transcriberFor, transcriberTierFor, transcriberKeyterms, stripHowMuchToSay, WIRE_BEHAVIOUR_RULES, WIRE_NUMBER_RULES, NAME_MAX, type AgentConfig } from "../lib/agentConfig.js";
import { buildTranscriberFallbackPlan } from "../lib/transcribers.js";
import { getEffective, integrationsStatus, getVapiPromptTemplate, getAgentLlm, getTranscriberFallback, getCountryStyle } from "./settings.js";
import { summarizePromptForVapi } from "./promptSummarizer.js";
import { getPlanFeatures, VAPI_MAX_CALL_SECONDS, clampCallSeconds } from "./trial.js";
import { regionalStyleSection, normalizeCountry } from "../lib/countryStyles.js";
import { isoCountryForPhone } from "../lib/phoneTimeZone.js";
import {
  deepgramVoiceFor,
  elevenLabsModelFor,
  elevenLabsVoiceFor,
  providerForVoiceId,
} from "./voices.js";
import { env } from "../env.js";
import { tenantForUser } from "./tenantDb.js";
import { traceFetch } from "./apiTrace.js";
import { getBookingConfig, type BookingConfig } from "./booking/config.js";
import { todayInZone } from "./booking/hours.js";
import { getSmsInfoConfig, type SmsInfoEntry } from "./smsInfo.js";

const VAPI_BASE = "https://api.vapi.ai";

// Vapi's 0.5s default splits a dictated phone number into separate turns; 1.5s spans
// the natural pause and matches Vapi's own no-punctuation wait, so no new worst case.
const NUMBER_ENDPOINTING_SECONDS = 1.5;

// The voice id decides the TTS provider (services/voices.ts is the single source of
// truth), so an empty/unknown voiceId resolves to the same default everywhere.

/** Who a provisioned assistant belongs to — used ONLY for the Vapi dashboard
 *  label + metadata, never for anything the caller hears. */
export interface AssistantOwner {
  id: string;
  email?: string | null;
  businessName?: string | null;
}

export interface VapiAssistantPayload {
  name: string;
  firstMessage: string;
  /** Assistant greets immediately on connect (so the call isn't silent). */
  firstMessageMode?: "assistant-speaks-first" | "assistant-waits-for-user";
  model: {
    provider: string;
    model: string;
    messages: { role: "system"; content: string }[];
    temperature: number;
    /** Always sent — an empty array is what clears a stale tool on PATCH. */
    tools?: AssistantTool[];
  };
  voice: { provider: string; voiceId: string; model?: string; speed?: number; stability?: number };
  /** STT. Multilingual agents use nova-3 "multi" so code-switching mid-call still transcribes. */
  transcriber?: {
    provider: string;
    model: string;
    language: string;
    /** Deepgram: formats numbers, phone numbers and addresses in the transcript. */
    smartFormat?: boolean;
    /** Deepgram: transcribe spoken numbers as digits ("eight five" → "85")
     *  instead of words. Separate from smartFormat, which does not do this. */
    numerals?: boolean;
    /** Deepgram nova-3 keyterm prompting (English only) — boosts recognition of
     *  the business's own vocabulary so domain words aren't misheard. */
    keyterm?: string[];
    fallbackPlan?: {
      transcribers: { provider: string; model?: string; language?: string; languages?: string[] }[];
    };
  };
  endCallFunctionEnabled: boolean;
  /** Hang-up backstop for when the LLM forgets the endCall tool. Always sent — [] clears stale phrases on PATCH. */
  endCallPhrases: string[];
  recordingEnabled: boolean;
  artifactPlan: { recordingEnabled: boolean; recordingFormat: "wav;l16" | "mp3" };
  /** Structured extraction on the end-of-call report — inbound calls carry no customer.name, so this is the only source for the CRM. */
  analysisPlan?: {
    structuredDataPlan: {
      enabled: boolean;
      schema: {
        type: "object";
        /** `enum` constrains a field to a closed set (used by `intent`) — Vapi
         *  passes the JSON Schema straight to the extraction model. */
        properties: Record<string, { type: string; description: string; enum?: string[] }>;
      };
    };
  };
  /** Per-call hard cap (seconds) so a call can't exceed the owner's remaining
   *  trial/plan minutes. Omitted for unlimited plans. */
  maxDurationSeconds?: number;
  /** Barge-in: stop talking the moment the caller starts speaking and hand the
   *  floor to them (don't finish the sentence first). */
  stopSpeakingPlan?: { numWords: number; voiceSeconds: number; backoffSeconds: number };
  /** Endpointing. Only the number case is set — see NUMBER_ENDPOINTING_SECONDS. */
  startSpeakingPlan?: {
    transcriptionEndpointingPlan?: {
      onPunctuationSeconds?: number;
      onNoPunctuationSeconds?: number;
      onNumberSeconds?: number;
    };
  };
  /** Real-time monitoring. `controlEnabled` is what exposes
   *  `call.monitor.controlUrl`, the channel the pre-cap wrap-up speaks over. */
  monitorPlan?: { controlEnabled?: boolean; listenEnabled?: boolean };
  /** Ambient sound under the call. Omitted → Vapi's default (office on phone). */
  backgroundSound?: "off" | "office";
  /** Where Vapi posts call events (end-of-call report) so we can email + log. */
  server?: { url: string };
  /** Owner stamp (customer id/email/business) — machine-readable link between a
   *  Vapi assistant and our customer record. Never reaches the LLM or the call. */
  metadata?: Record<string, string>;
}

// Dashboard-only label "<name> - <owner> #<id6>". Vapi's `name` never reaches the LLM,
// so the agent still just says "Mark" on calls.
function dashboardName(spokenLabel: string, owner?: AssistantOwner | null): string {
  if (!owner?.id) return spokenLabel;
  const tag = ` #${owner.id.slice(-6)}`;
  const who = (owner.businessName?.trim() || owner.email?.split("@")[0] || "").trim();
  const full = who ? `${spokenLabel} - ${who}${tag}` : `${spokenLabel}${tag}`;
  if (full.length <= NAME_MAX) return full;
  // Over the 40-char cap: shrink the owner part first, then the label — the #id
  // tag always survives since it's the part that disambiguates duplicates.
  const room = NAME_MAX - spokenLabel.length - tag.length - " - ".length;
  if (who && room >= 3) return `${spokenLabel} - ${who.slice(0, room).trim()}${tag}`;
  return `${spokenLabel.slice(0, NAME_MAX - tag.length).trim()}${tag}`;
}

/** Resolve the owning user for the dashboard label + metadata. Best-effort — a
 *  lookup failure must never block provisioning, so it returns null instead. */
async function assistantOwner(userId?: string | null): Promise<AssistantOwner | null> {
  if (!userId) return null;
  try {
    const user = await (await tenantForUser(userId)).user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, profile: { select: { businessName: true } } },
    });
    if (!user) return null;
    return { id: user.id, email: user.email, businessName: user.profile?.businessName };
  } catch {
    return null;
  }
}

/** Load the owner's human-transfer config for assistant provisioning. Returns a
 *  disabled plan on any miss/failure so provisioning never breaks on it. */
async function getTransferPlan(ownerId: string | null): Promise<TransferPlan> {
  const off: TransferPlan = {
    enabled: false,
    fallbackMessage: "",
    transferNumber: "",
    ringTimeoutSec: 25,
    departments: [],
  };
  if (!ownerId) return off;
  try {
    // Plan gate first: attaching the tool is what gives callers the handoff, so a
    // downgrade must drop it here, not whenever the owner next saves the page.
    const maxDepartments = (await getPlanFeatures(ownerId)).callTransferDepartments;
    if (maxDepartments === 0) return off;
    const db = await tenantForUser(ownerId);
    const [settings, departments] = await Promise.all([
      db.humanTransferSettings.findUnique({ where: { userId: ownerId } }),
      db.transferDepartment.findMany({
        where: { userId: ownerId, enabled: true },
        orderBy: [{ order: "asc" }, { createdAt: "asc" }],
      }),
    ]);
    if (!settings) return off;
    return {
      enabled: settings.enabled,
      fallbackMessage: settings.fallbackMessage,
      transferNumber: settings.transferNumber,
      ringTimeoutSec: settings.ringTimeoutSec,
      // Clamped to the plan as a backstop — rows can predate the limit or an admin
      // can lower a plan under live users. Stable order, so always the same first N.
      departments: departments.slice(0, maxDepartments).map((d) => ({
        name: d.name,
        number: d.number,
        description: d.description,
        ringTimeoutSec: d.ringTimeoutSec,
        fallbackMessage: d.fallbackMessage,
      })),
    };
  } catch {
    return off;
  }
}

/** Whether booking is live for an owner: Google connected AND not paused. */
export interface BookingContext {
  enabled: boolean;
}

/** Live Google Calendar booking — connected AND not paused. Best-effort. */
export async function getBookingContext(ownerId: string | null): Promise<BookingContext> {
  const off: BookingContext = { enabled: false };
  if (!ownerId) return off;
  try {
    const crm = await (await tenantForUser(ownerId)).crmIntegration.findUnique({
      where: { userId: ownerId },
      select: { googleCalendarConnected: true, bookingEnabled: true },
    });
    return { enabled: !!crm?.googleCalendarConnected && !!crm.bookingEnabled };
  } catch {
    return off;
  }
}

/** Convenience boolean wrapper (used where only the on/off state is needed). */
export async function isBookingEnabled(ownerId: string | null): Promise<boolean> {
  return (await getBookingContext(ownerId)).enabled;
}

/** Pre-summarization system prompt: the frozen manual edit if any, else a fresh compile on the wire scaffold. */
export function baseSystemPrompt(config: AgentConfig): string {
  if (!config.advanced.masterPromptDirty) {
    return compileMasterPrompt(config, getVapiPromptTemplate());
  }
  // Frozen (manually edited) prompt. Languages enabled AFTER the edit would
  // otherwise never reach the live agent — graft the compiled block on.
  const prompt = config.advanced.masterPrompt;
  const languages = sanitizeAgentLanguages(
    config.identity.languages,
    providerForVoiceId(config.identity.voiceId),
  );
  if (languages.length && !/##\s*LANGUAGES/i.test(prompt)) {
    return `${prompt.trimEnd()}\n\n${compileLanguagesSection(languages)}`;
  }
  return prompt;
}

// ISO country for the regional style: config, else the AI number, else the mobile.
async function resolveAssistantCountry(config: AgentConfig, ownerId?: string | null): Promise<string> {
  const explicit = normalizeCountry(config.identity.country);
  if (explicit) return explicit;
  if (!ownerId) return "";
  const profile = await tenantForUser(ownerId)
    .then((db) => db.profile.findUnique({ where: { userId: ownerId }, select: { receptionistNumber: true, mobile: true } }))
    .catch(() => null);
  return isoCountryForPhone(profile?.receptionistNumber) || isoCountryForPhone(profile?.mobile);
}

/** Final wire prompt: summarized, then the regional style appended AFTER summarization so local phrasing survives verbatim and frozen prompts get it too. */
export async function buildVapiSystemPrompt(config: AgentConfig, ownerId?: string | null): Promise<string> {
  const summarized = await summarizePromptForVapi(baseSystemPrompt(config));
  const iso = await resolveAssistantCountry(config, ownerId);
  const section = regionalStyleSection(getCountryStyle(iso));
  const withStyle = section ? `${summarized.trimEnd()}\n\n${section}` : summarized;
  // Behaviour + number rules are platform guarantees: stamped on EVERY assistant (frozen prompts never
  // see template changes), after summarization so they survive, with any old copy stripped so it can't contradict.
  return `${stripHowMuchToSay(withStyle)}\n\n${WIRE_BEHAVIOUR_RULES}\n\n${WIRE_NUMBER_RULES}`;
}

// The operator-leg mini assistant: announces the caller and bridges only if the human agrees.
interface VapiTransferAssistant {
  /** First thing spoken to the human when they pick up. */
  firstMessage: string;
  /** The operator-leg assistant speaks first (announces the caller). */
  firstMessageMode: "assistant-speaks-first" | "assistant-waits-for-user";
  /** Cap the operator-leg call so a no-answer/voicemail can't hang forever. */
  maxDurationSeconds?: number;
  /** Give up the operator leg after this much silence (no-one there / voicemail). */
  silenceTimeoutSeconds?: number;
  model: {
    provider: string;
    model: string;
    messages: { role: "system"; content: string }[];
  };
}

// warm-transfer-experimental holds the caller and bridges only when the operator-leg assistant calls its success tool.
interface VapiTransferPlan {
  mode: "warm-transfer-experimental";
  transferAssistant: VapiTransferAssistant;
}

/** A Vapi `transferCall` destination — one number the AI can bridge the caller to. */
interface VapiTransferDestination {
  type: "number";
  number: string;
  /** Helps the LLM pick this destination when several exist. */
  description?: string;
  /** Warm-transfer behaviour (hold + operator-leg assistant + answer gating). */
  transferPlan?: VapiTransferPlan;
}

// Spoken messages live at the tool root — Vapi ignores them per-destination.
interface VapiToolMessage {
  type: "request-start" | "request-failed";
  content: string;
  /** For request-failed: hang up after the message is spoken. */
  endCallAfterSpokenEnabled?: boolean;
}

export interface VapiTool {
  type: "transferCall";
  destinations: VapiTransferDestination[];
  messages?: VapiToolMessage[];
}

/** A server-backed function tool: Vapi POSTs the call to `server.url` and speaks the `result` back. */
export interface VapiFunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      /** `enum` (on the param or its array `items`) is how sendInfoSms stays pinned to the owner's catalogue. */
      properties: Record<
        string,
        {
          type: string;
          description: string;
          enum?: string[];
          items?: { type: string; enum?: string[] };
        }
      >;
      required?: string[];
    };
  };
  /** Where Vapi sends the tool invocation (our dispatcher, stamped with ?uid). */
  server: { url: string };
  messages?: VapiToolMessage[];
}

/** Any tool attached to an assistant's model. */
export type AssistantTool = VapiTool | VapiFunctionTool;

/** One transfer department: a named line the caller can be routed to. */
export interface TransferDepartmentPlan {
  /** Caller-facing name, e.g. "Sales". */
  name: string;
  /** E.164 number the caller is warm-transferred to. */
  number: string;
  /** Hint to help the LLM route to this department, e.g. "billing, refunds". */
  description?: string;
  /** How long this department's number rings before we give up (seconds). */
  ringTimeoutSec?: number;
  /** Spoken when this department's transfer can't connect. */
  fallbackMessage?: string;
}

/** The owner's live human-transfer config, resolved for assistant provisioning. */
export interface TransferPlan {
  enabled: boolean;
  fallbackMessage: string;
  /** The single fallback number the AI bridges the caller to when no
   *  departments are configured (backward compatible with the one-number setup). */
  transferNumber: string;
  /** How long the human's phone rings before we give up (seconds). */
  ringTimeoutSec: number;
  /** Named departments, each with its own number. When non-empty, the AI asks the
   *  caller which department they need and routes to the matching destination. */
  departments: TransferDepartmentPlan[];
}

/** Default fallback line spoken to the caller when the human can't be reached. */
const DEFAULT_TRANSFER_FALLBACK =
  "Our team isn't available right now. We've recorded your request and will contact you as soon as possible. Thank you for calling.";

/** Normalize a stored number to the clean E.164 Vapi requires (+ and digits). */
function toDialE164(raw: string): string {
  const trimmed = (raw || "").trim();
  const plus = trimmed.startsWith("+") ? "+" : "";
  return plus + trimmed.replace(/\D/g, "");
}

// Enabled departments with a valid number, in display order. Empty = no transfer at all.
function activeDepartments(plan: TransferPlan): TransferDepartmentPlan[] {
  return (plan.departments ?? [])
    .map((d) => ({ ...d, number: toDialE164(d.number) }))
    .filter((d) => d.name.trim() && d.number.length >= 7);
}

/** Default LLM for the operator-leg transfer assistant. Kept capable + tool-
 *  calling-friendly; overridden with the account's agent LLM when available. */
const DEFAULT_TRANSFER_LLM = { provider: "openai", model: "gpt-4o" };

// One warm-transfer destination. `label` is what the operator-leg assistant announces.
function transferDestination(
  number: string,
  label: string,
  description: string,
  timeout: number,
  llm: { provider: string; model: string },
): VapiTransferDestination {
  return {
    type: "number",
    number,
    description,
    transferPlan: {
      mode: "warm-transfer-experimental",
      transferAssistant: {
        firstMessage: `Hello, this is an automated assistant. There's a caller on the line who'd like to speak with ${label}. Are you available to take the call?`,
        firstMessageMode: "assistant-speaks-first",
        maxDurationSeconds: timeout > 0 ? timeout + 15 : 40,
        silenceTimeoutSeconds: timeout >= 10 ? timeout : 20,
        model: {
          provider: llm.provider,
          model: llm.model,
          messages: [
            {
              role: "system",
              content: [
                `You are connecting a caller to ${label}.`,
                "Briefly greet the person who answered and tell them a caller would like to speak with them.",
                "If they say yes / they're available / okay, immediately call the transferSuccessful tool to connect the caller.",
                "If they say no, they're busy, it's a wrong number, or you reach voicemail / no one responds, call the transferCancel tool.",
                "Keep it short — one sentence, then act on their answer.",
              ].join(" "),
            },
          ],
        },
      },
    },
  };
}

/** The transferCall tool: one warm destination per active department. Null when off or no valid department. `llm` runs the operator-leg assistant. */
export function buildTransferTool(
  plan: TransferPlan | null | undefined,
  llm: { provider: string; model: string } = DEFAULT_TRANSFER_LLM,
): VapiTool | null {
  if (!plan?.enabled) return null;

  // Departments are the ONLY transfer path — no fallback to the legacy transferNumber,
  // so a deleted department can never keep connecting callers via a stale number.
  const depts = activeDepartments(plan);
  if (!depts.length) return null;

  // Vapi has one tool-level request-failed message, so the first department's is used.
  const primaryFallback = depts[0].fallbackMessage?.trim() || DEFAULT_TRANSFER_FALLBACK;
  return {
    type: "transferCall",
    destinations: depts.map((d) =>
      transferDestination(
        d.number,
        `the ${d.name} team`,
        // Description drives the LLM's destination pick — lead with the
        // department name, then any extra routing hints the owner set.
        d.description?.trim()
          ? `The ${d.name} department. Route here for: ${d.description.trim()}`
          : `The ${d.name} department`,
        d.ringTimeoutSec && d.ringTimeoutSec > 0 ? d.ringTimeoutSec : 15,
        llm,
      ),
    ),
    messages: [
      { type: "request-start", content: "Please stay on the line — I'm connecting you now." },
      // Don't hang up after "couldn't connect" — the AI takes a message instead.
      { type: "request-failed", content: primaryFallback, endCallAfterSpokenEnabled: false },
    ],
  };
}

/** Prompt block: when to transfer, which department to ask for, and how to take a message when it can't connect. */
export function transferPromptSection(plan: TransferPlan): string {
  const depts = activeDepartments(plan);
  const base = [
    "## HUMAN TRANSFER",
    "You can connect the caller to a real person using the transferCall tool.",
    "Use it as soon as the caller wants a human — e.g. they say things like “talk to a person”, “real human”, “speak to an agent/representative/manager”, “customer support”, “someone real”, or they're upset, frustrated, or the request is beyond what you can handle.",
  ];

  if (depts.length) {
    const list = depts
      .map((d) => `- ${d.name}${d.description?.trim() ? ` — ${d.description.trim()}` : ""}`)
      .join("\n");
    base.push(
      "There are several departments you can transfer to:",
      list,
      "When the caller wants a human, first ask which department they need (unless it's already obvious from the conversation — e.g. a billing question clearly goes to Billing). Once you know, briefly reassure them (e.g. “Sure, let me connect you to the {department} team — please hold.”) and call the transferCall tool with the destination for THAT department.",
      "Only pick from the departments listed above. If the caller's need doesn't clearly match one, ask a short clarifying question rather than guessing.",
    );
  } else {
    base.push(
      "Before transferring, briefly reassure them (e.g. “Sure, let me connect you to someone who can help — please hold.”) then call the transferCall tool.",
    );
  }

  base.push(
    "Never read out or reveal any phone number. The system automatically holds the caller while it rings the team and only connects them if the team member answers and agrees.",
    "## IF THE TRANSFER CAN'T CONNECT",
    "If the team member is unavailable, doesn't answer, or declines, the system speaks a short “couldn't connect” line and then hands the call back to YOU — do not end the call there. Instead, take a message:",
    "- Briefly apologise that the team couldn't be reached right now.",
    "- Ask for the caller's name and the reason for their call (and a callback number if you don't already have it).",
    "- Make clear you'll pass the message to the department they asked for, so that team can call them back — and always note WHICH department the caller had selected in the message.",
    "- Once you've taken the message, thank them and end the call.",
  );
  return base.join("\n");
}

/** Booking block grafted onto the live prompt. Kept out of the editable AI Brain — it's behaviour derived from integration state, not prompt content. */
export function bookingPromptSection(config: BookingConfig): string {
  const today = todayInZone(config.timezone);
  const lines: string[] = [
    "## BOOKINGS",
    "Booking is an EXTRA ability — it never changes how you handle other calls; anyone ringing about questions, quotes, messages or complaints is always helped as normal.",
    `Today is ${today.weekday}, ${today.dateISO} (timezone ${config.timezone}). Resolve any relative date the caller uses ("today", "tomorrow", "next Tuesday") against this.`,
    "",
  ];

  if (config.canAutoBook) {
    lines.push(
      "When a caller wants to book, book it for them yourself on this call:",
      "- Ask which day they'd like, then call checkAvailability with that date to get the open times. Offer ONLY the times the tool returns — never invent or guess availability, and never promise a time the tool didn't list.",
      "- Ask for their name (if they won't give one, that's fine — leave it blank; NEVER make up a name) and the best phone number for the booking.",
      "- CRITICAL: once they pick an open time, you MUST call the createBooking tool with the date, time, and their details — and put WHAT they're booking (e.g. \"haircut\", \"room booking\", \"consultation\") in the notes, since that becomes the calendar title. The appointment is NOT booked until createBooking runs and returns a success message. NEVER tell the caller they're booked, confirmed, or will get a confirmation text unless createBooking has ACTUALLY returned success in this call — do not assume, pretend, or say it in advance. If the tool reports the time is unavailable or errors, tell the caller and offer another time; do not claim it worked.",
      "- After createBooking returns success, repeat back what it confirmed.",
      "- If they later want to change or cancel, use rescheduleBooking or cancelBooking (found by their phone number).",
    );
  } else {
    lines.push(
      "When a caller wants to book, you cannot book it directly on this call. Take their name, number and reason as a message so the team can follow up. Never claim a booking is scheduled or confirmed.",
    );
  }

  lines.push(
    "",
    "Never invent availability. Never invent a caller's name — ask for it, and leave it empty if they don't give one.",
  );
  return lines.join("\n");
}

/** Booking prompt + tools, shared by the live assistant, the web-test route and the frontend so all three behave the same. */
export interface BookingToolConfig {
  enabled: boolean;
  canAutoBook: boolean;
  tools: VapiFunctionTool[];
  promptSection: string;
}

const BOOKING_DISABLED: BookingToolConfig = {
  enabled: false,
  canAutoBook: false,
  tools: [],
  promptSection: "",
};

/** Booking function tools, only when the owner can auto-book. Each posts to our dispatcher with `?uid=` so web test calls (no persisted assistant) still resolve the business. */
export function buildBookingTools(
  config: BookingConfig,
  ownerId: string,
  serverBase: string,
): VapiFunctionTool[] {
  const url = `${serverBase}/api/booking/ai?uid=${encodeURIComponent(ownerId)}`;
  const tools: VapiFunctionTool[] = [];

  if (config.canAutoBook) {
    tools.push({
      type: "function",
      function: {
        name: "checkAvailability",
        description:
          "Get the open appointment times for a specific date. Call this before offering any times. Returns the available slots — only offer times it returns.",
        parameters: {
          type: "object",
          properties: {
            date: {
              type: "string",
              description:
                "The date to check, as YYYY-MM-DD, resolved from what the caller said against today's date.",
            },
          },
          required: ["date"],
        },
      },
      server: { url },
      messages: [{ type: "request-start", content: "Let me check what's available." }],
    });

    tools.push({
      type: "function",
      function: {
        name: "createBooking",
        description:
          "Book an appointment at a specific open time for the caller. Only call after checkAvailability confirmed the time is free and the caller chose it.",
        parameters: {
          type: "object",
          properties: {
            date: { type: "string", description: "The appointment date as YYYY-MM-DD." },
            time: {
              type: "string",
              description:
                "The chosen start time, matching one of the times checkAvailability returned (e.g. '15:00' or '3:00 PM').",
            },
            name: {
              type: "string",
              description:
                "The caller's name if they gave one. Leave empty if they didn't — never invent a name.",
            },
            phone: {
              type: "string",
              description: "The caller's phone number. Leave empty to use the number they're calling from.",
            },
            email: { type: "string", description: "The caller's email if provided, otherwise empty." },
            notes: {
              type: "string",
              description:
                "WHAT the caller is booking, in a few words — e.g. 'haircut', 'room booking', 'beard trim', 'consultation'. Taken from what they said they want. This becomes the calendar event title, so always fill it in when you know it. Empty only if truly unclear.",
            },
          },
          required: ["date", "time"],
        },
      },
      server: { url },
      messages: [{ type: "request-start", content: "Great — booking that in for you now." }],
    });

    tools.push({
      type: "function",
      function: {
        name: "cancelBooking",
        description: "Cancel the caller's existing upcoming appointment, found by their phone number.",
        parameters: {
          type: "object",
          properties: {
            phone: {
              type: "string",
              description: "The caller's phone number. Leave empty to use the number they're calling from.",
            },
          },
          required: [],
        },
      },
      server: { url },
    });

    tools.push({
      type: "function",
      function: {
        name: "rescheduleBooking",
        description:
          "Move the caller's existing upcoming appointment to a new date/time, found by their phone number. Check availability for the new time first.",
        parameters: {
          type: "object",
          properties: {
            date: { type: "string", description: "The new date as YYYY-MM-DD." },
            time: { type: "string", description: "The new start time (e.g. '15:00' or '3:00 PM')." },
            phone: {
              type: "string",
              description: "The caller's phone number. Leave empty to use the number they're calling from.",
            },
          },
          required: ["date", "time"],
        },
      },
      server: { url },
    });
  }

  return tools;
}

/** Booking prompt + tools for an owner. Best-effort. */
export async function getBookingToolConfig(ownerId: string | null): Promise<BookingToolConfig> {
  if (!ownerId) return BOOKING_DISABLED;
  const base = webhookServerUrl();
  try {
    const stored = await getBookingConfig(ownerId);
    // INVARIANT: the prompt only describes abilities the AI has. No public URL means no
    // reachable tools, so drop canAutoBook too; take-a-message needs no callback.
    const config = base ? stored : { ...stored, canAutoBook: false };
    const tools = base ? buildBookingTools(config, ownerId, base) : [];
    // The prompt section always ships; tools are just empty when it can't auto-book.
    return {
      enabled: true,
      canAutoBook: config.canAutoBook,
      tools,
      promptSection: bookingPromptSection(config),
    };
  } catch {
    return BOOKING_DISABLED;
  }
}

// sendInfoSms: ONE tool with the topics as an enum array (ten tools would hurt routing).
// The body is never a parameter — rendered server-side so a caller can't dictate the text.

export interface SmsInfoToolConfig {
  enabled: boolean;
  tools: VapiFunctionTool[];
  promptSection: string;
}

const SMS_INFO_DISABLED: SmsInfoToolConfig = { enabled: false, tools: [], promptSection: "" };

/** Build the single sendInfoSms tool from the owner's live catalogue. */
export function buildInfoSmsTool(
  entries: SmsInfoEntry[],
  ownerId: string,
  serverBase: string,
): VapiFunctionTool {
  const url = `${serverBase}/api/ai/sms?uid=${encodeURIComponent(ownerId)}`;
  const guide = entries
    .map((e) => {
      const when = e.item.whenToUse.trim();
      return `"${e.item.key}" = ${e.item.label}${when ? ` (use when ${when})` : ""}`;
    })
    .join("; ");
  return {
    type: "function",
    function: {
      name: "sendInfoSms",
      description:
        "Text the caller the specific business information they asked for, in ONE message. " +
        "List every topic they want in `topics` — if they ask for several things at once, " +
        "include them all in a single call so they get one text, not several. " +
        "Call this only after you have offered to text it AND the caller has clearly agreed. " +
        `Topics: ${guide}.`,
      parameters: {
        type: "object",
        properties: {
          topics: {
            type: "array",
            items: { type: "string", enum: entries.map((e) => e.item.key) },
            description:
              "Every piece of information the caller asked for, as topic keys. Usually one; include several only when they asked for more than one thing.",
          },
          phone: {
            type: "string",
            description:
              "The caller's mobile number to text, in the format they gave it. Leave empty to use the number they're calling from.",
          },
          consentGiven: {
            type: "boolean",
            description:
              "True ONLY when the caller has clearly agreed to receive the text after you offered it. Never set this true if you haven't asked them.",
          },
        },
        required: ["topics", "consentGiven"],
      },
    },
    server: { url },
    messages: [{ type: "request-start", content: "Sure — sending that through to you now." }],
  };
}

/** Teach the assistant WHAT it can text and the offer-then-confirm etiquette
 *  around it. Without this the tool exists but is never used naturally. */
export function smsInfoPromptSection(entries: SmsInfoEntry[]): string {
  const list = entries
    .map((e) => {
      const when = e.item.whenToUse.trim();
      return `- ${e.item.label} (topic "${e.item.key}")${when ? ` — when ${when}` : ""}`;
    })
    .join("\n");
  return [
    "## TEXTING INFORMATION TO CALLERS",
    "You can send the caller a text message with any of these details when they ask for one:",
    list,
    "How to use this:",
    "- Answer their question out loud first, then offer the text: \"Would you like me to text that to you?\" Never send anything they didn't agree to.",
    "- Only use the sendInfoSms tool once they've clearly said yes, and set consentGiven to true only then. If they say no, drop it and carry on — don't ask twice.",
    "- If the caller asks for more than one of these at once, list every topic they asked for in a single sendInfoSms call — they'll get it all in one text, not several.",
    "- Never read a long web address or email out character by character. Say it naturally once, then offer to text it.",
    "- Send each detail only once per call. If they ask again, tell them it's already on its way rather than sending it twice.",
    "- By default it goes to the number they're calling from. Only pass a phone number if they give you a different one.",
    "- This tool is for information the caller asked for. If they want to book an appointment, handle the booking properly instead of just texting them a link.",
  ].join("\n");
}

/** SMS-on-request prompt + tool. Disabled when off, unrenderable, or no public URL. Best-effort. */
export async function getSmsInfoToolConfig(ownerId: string | null): Promise<SmsInfoToolConfig> {
  if (!ownerId) return SMS_INFO_DISABLED;
  const base = webhookServerUrl();
  if (!base) return SMS_INFO_DISABLED; // no reachable server → don't attach the tool
  try {
    // Plan gate here, not just the UI — the toggle can outlive the entitlement.
    if (!(await getPlanFeatures(ownerId)).smsToCaller) return SMS_INFO_DISABLED;
    const config = await getSmsInfoConfig(ownerId);
    if (!config.enabled || !config.entries.length) return SMS_INFO_DISABLED;
    return {
      enabled: true,
      tools: [buildInfoSmsTool(config.entries, ownerId, base)],
      promptSection: smsInfoPromptSection(config.entries),
    };
  } catch {
    return SMS_INFO_DISABLED;
  }
}

/** Sign-offs that hard-end the call. Nothing that appears in a greeting (or calls end at hello), and MUST include the prompt's scripted sign-off or the agent falls back to a bare "Goodbye." */
export const END_CALL_PHRASES = [
  "goodbye",
  "have a good one",
  "bye for now",
  "bye now",
  "take care",
  "speak soon",
  "have a great day",
  "have a good day",
  "have a wonderful day",
  "have a lovely day",
  "have a nice day",
  "enjoy the rest of your day",
];

// Old CLOSING blocks said "Don't hang up first", which contradicts ENDING THE CALL and
// left the line open. Frozen/hand-edited prompts still carry it, so strip that sentence.
const DONT_HANG_UP_FIRST_RE = /\s*Don['’]t hang up first[^.]*\.\s*/gi;

export function stripDontHangUpFirst(prompt: string): string {
  const stripped = prompt.replace(DONT_HANG_UP_FIRST_RE, " ");
  return stripped === prompt ? prompt : stripped.replace(/[ \t]+\n/g, "\n").trimEnd();
}

/** Grafted on when hang-up is allowed — teaches the LLM to actually call endCall after signing off. */
export function endCallPromptSection(): string {
  return [
    "## ENDING THE CALL",
    "When the conversation is clearly over — the caller says goodbye, \"no thanks\", \"that's all\", or declines more help after you've wrapped up — say EXACTLY this, word for word:",
    "\"No worries at all — thanks for calling, have a great day!\"",
    "Then IMMEDIATELY use the endCall tool to hang up. Say that whole sentence — never shorten it to a single word, never swap it for a shorter sign-off, and never add anything after it.",
    "Never leave the line open waiting for the caller to hang up first, and never ask another question after the caller has said goodbye.",
  ].join("\n");
}

/** The Vapi assistant payload for a config. `systemPrompt` overrides the compiled prompt (the summarized wire copy); the tool configs graft their prompt blocks and tools. */
export function buildAssistantPayload(
  config: AgentConfig,
  opts?: {
    maxDurationSeconds?: number | null;
    owner?: AssistantOwner | null;
    systemPrompt?: string;
    transfer?: TransferPlan | null;
    /** Booking prompt + tools (from getBookingToolConfig). */
    booking?: BookingToolConfig | null;
    /** "Text Info to Callers" behaviour + the sendInfoSms tool (from
     *  getSmsInfoToolConfig). */
    infoSms?: SmsInfoToolConfig | null;
  },
): VapiAssistantPayload {
  const basePrompt = opts?.systemPrompt?.trim() || baseSystemPrompt(config);
  // The operator-leg assistant runs on gpt-4o, NOT the account's LLM — a model that
  // flubs the transferSuccessful/transferCancel tool calls makes Vapi blind-bridge.
  const transferTool = buildTransferTool(opts?.transfer);
  const withTransfer = transferTool
    ? `${basePrompt.trimEnd()}\n\n${transferPromptSection(opts!.transfer!)}`
    : basePrompt;
  // Teach the AI the website-first booking behaviour when booking is live.
  const withBooking = opts?.booking?.enabled
    ? `${withTransfer.trimEnd()}\n\n${opts.booking.promptSection}`
    : withTransfer;
  // Teach the AI what it may text a caller who asks for a detail, and the
  // offer-then-confirm etiquette around it.
  const withInfoSms = opts?.infoSms?.enabled
    ? `${withBooking.trimEnd()}\n\n${opts.infoSms.promptSection}`
    : withBooking;
  // Only when endCall exists (never instruct a missing tool); strip "don't hang up
  // first" or the two instructions cancel out.
  const systemPrompt = config.advanced.allowHangUp
    ? `${stripDontHangUpFirst(withInfoSms).trimEnd()}\n\n${endCallPromptSection()}`
    : withInfoSms;

  // Vapi caps `name` at 40 chars — a long scraped business title 400s the whole provision.
  const businessName = config.identity.businessName?.trim();
  const assistantLabel = (
    config.identity.assistantName?.trim() ||
    (businessName ? `${businessName} Receptionist` : "") ||
    "Receptionist"
  )
    .slice(0, NAME_MAX)
    .trim();

  // An empty greeting left the assistant silent on connect; resolveGreeting also
  // re-derives a stale generated greeting so a business rename reaches live calls.
  const greeting = resolveGreeting(config.identity.greetingMessage, businessName);

  // Admin default LLM, stamped on every create AND sync so a change rolls out on the next save.
  const llm = getAgentLlm();

  // Multilingual changes the whole pipeline: STT goes to nova-3 "multi" (or Hindi arrives
  // as garbled English) and TTS must be ElevenLabs (Deepgram Aura-2 is English-only).
  const languages = sanitizeAgentLanguages(
    config.identity.languages,
    providerForVoiceId(config.identity.voiceId),
  );

  const voice =
    providerForVoiceId(config.identity.voiceId) === "elevenlabs" || languages.length
      ? {
          provider: "11labs",
          voiceId: elevenLabsVoiceFor(config.identity.voiceId),
          // Turbo v2.5 for everything, except the one pairing it can't carry:
          // the curated Punjabi voice with Punjabi enabled → Eleven v3.
          model: elevenLabsModelFor(config.identity.voiceId, languages),
          speed: config.advanced.voiceSpeed,
          stability: config.advanced.voiceStability,
        }
      : { provider: "deepgram", voiceId: deepgramVoiceFor(config.identity.voiceId), model: "aura-2" };

  return {
    // Always sent — a PATCH without the key keeps the old transcriber, so a language
    // toggle would never land. Google's model covers Punjabi/Mandarin, which "multi" can't hear.
    transcriber: (() => {
      const primary = transcriberFor(languages);
      // nova-3 keyterm prompting is English-only.
      const keyterm =
        primary.provider === "deepgram" && primary.language === "en"
          ? transcriberKeyterms(config)
          : [];
      // `numerals` turns spoken digits into "85804" — smartFormat alone doesn't, and the LLM got numbers
      // as words (the "can you repeat that?" loops). Unsupported languages (Hindi, Japanese) just ignore it.
      const boosted =
        primary.provider === "deepgram"
          ? { ...primary, smartFormat: true, numerals: true, ...(keyterm.length ? { keyterm } : {}) }
          : primary;
      const plan = buildTranscriberFallbackPlan(getTranscriberFallback(), transcriberTierFor(languages));
      return plan ? { ...boosted, fallbackPlan: plan } : boosted;
    })(),
    // Dashboard-only label — the spoken name (prompt + greeting) stays untouched.
    name: dashboardName(assistantLabel, opts?.owner),
    firstMessage: greeting,
    firstMessageMode: "assistant-speaks-first",
    model: {
      provider: llm.provider,
      model: llm.model,
      messages: [{ role: "system", content: systemPrompt }],
      temperature: config.advanced.creativity,
      // Always sent so turning a feature OFF strips its stale tool on PATCH.
      tools: [
        ...(transferTool ? [transferTool] : []),
        ...(opts?.booking?.tools ?? []),
        ...(opts?.infoSms?.tools ?? []),
      ],
    },
    voice,
    endCallFunctionEnabled: config.advanced.allowHangUp,
    endCallPhrases: config.advanced.allowHangUp ? END_CALL_PHRASES : [],
    recordingEnabled: true,
    // MP3, not wav;l16: ~1 MB/min instead of ~10, and owners forward these to people who
    // expect a file that just plays. Old WAV recordings keep working (format comes from content-type).
    artifactPlan: { recordingEnabled: true, recordingFormat: "mp3" },
    // Barge-in on the first word.
    stopSpeakingPlan: { numWords: 0, voiceSeconds: 0.2, backoffSeconds: 1 },
    // Only the number case is stretched (see NUMBER_ENDPOINTING_SECONDS); other timings
    // keep Vapi's defaults so ordinary replies stay snappy.
    startSpeakingPlan: {
      transcriptionEndpointingPlan: { onNumberSeconds: NUMBER_ENDPOINTING_SECONDS },
    },
    // Stated, not assumed: the pre-cap wrap-up (callWrapUp.ts) depends on controlUrl, and
    // an account default flipping off would turn every capped call into a mid-sentence hang-up.
    monitorPlan: { controlEnabled: true },
    // Ambient call sound. "default" (or unset) → omit so Vapi applies its own
    // default (office on phone); "off"/"office" force the choice.
    ...(config.advanced.backgroundSound === "off" || config.advanced.backgroundSound === "office"
      ? { backgroundSound: config.advanced.backgroundSound }
      : {}),
    // Have Vapi extract the caller's details from the transcript so leads pushed
    // to the CRM carry a real name/number instead of falling back to "Unknown".
    analysisPlan: {
      structuredDataPlan: {
        enabled: true,
        schema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "The caller's full name exactly as they gave it during the call. Empty string if the caller never provided a name.",
            },
            phone: {
              type: "string",
              description:
                "The best callback phone number the caller provided, in the format they said it. Empty string if none was given.",
            },
            email: {
              type: "string",
              description:
                "The caller's email address if they provided one. Empty string otherwise.",
            },
            purpose: {
              type: "string",
              description:
                "A very short (3-6 word) description of why the caller rang — e.g. 'Booking a haircut', 'Quote for bathroom reno', 'Complaint about late delivery'. Used as the one-line 'Purpose' in the owner's summary SMS. Empty string if unclear.",
            },
            // Only the categories needing judgement. lead and booking are decided
            // server-side from what actually happened (lib/callIntent.ts) — "I'd like to book" isn't a booking.
            intent: {
              type: "string",
              enum: ["support", "spam", ""],
              description:
                "Classify the call as ONE of: 'support' if the caller is an EXISTING customer with " +
                "a problem, complaint, or an order/job to chase up; 'spam' if it was a wrong " +
                "number, robocall, telemarketer, or nothing meaningful was said. For anything " +
                "else — a general question, a price enquiry, a new customer asking about your " +
                "services, or someone asking to make a booking — return an empty string. Do not guess.",
            },
            ...(opts?.transfer?.enabled
              ? {
                  requestedDepartment: {
                    type: "string",
                    description:
                      "The team or department the caller asked to be connected to (e.g. 'Sales', 'Billing', 'Support'), or 'a person' if they asked to speak to a human without naming a department. Empty string if the caller never asked to be transferred to a human.",
                  },
                }
              : {}),
          },
        },
      },
    },
    ...(typeof opts?.maxDurationSeconds === "number" &&
    Number.isFinite(opts.maxDurationSeconds) &&
    opts.maxDurationSeconds > 0
      ? { maxDurationSeconds: Math.floor(opts.maxDurationSeconds) }
      : {}),
    // Without a public URL in prod, real inbound calls never get logged.
    ...(webhookServerUrl()
      ? {
          server: {
            url: `${webhookServerUrl()}/api/calls/webhook/vapi`,
            // Vapi echoes this in x-vapi-secret so the webhook can reject a forged "call
            // ended" POST (which could drain minutes or trigger a charge). Verified in calls.routes.ts.
            ...(getEffective("vapi.webhookSecret").trim()
              ? { secret: getEffective("vapi.webhookSecret").trim() }
              : {}),
          },
        }
      : {}),
    // Stamp the owner so every assistant is traceable to a customer via the API,
    // independent of what the display name says.
    ...(opts?.owner?.id
      ? {
          metadata: {
            customerId: opts.owner.id,
            ...(opts.owner.email ? { customerEmail: opts.owner.email } : {}),
            ...(opts.owner.businessName?.trim()
              ? { businessName: opts.owner.businessName.trim() }
              : {}),
          },
        }
      : {}),
  };
}

/** Public base URL for Vapi callbacks, or "" (local dev without a tunnel) — attach no live tools then. */
export function webhookServerUrl(): string {
  return (env.VAPI_SERVER_URL || env.PUBLIC_API_URL || "").replace(/\/$/, "");
}

async function vapiFetch(path: string, init: RequestInit) {
  if (!integrationsStatus().vapi) throw notImplemented("Voice calling isn't configured (set the voice API key in Admin → Settings)");
  const res = await traceFetch(
    "vapi",
    `${VAPI_BASE}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${getEffective("vapi.apiKey")}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    },
    { endpoint: path },
  );
  if (!res.ok) {
    const text = await res.text();
    // Never surface Vapi's auth codes as the *client's* 401/403 — that would
    // log the admin out mid-approval. Re-map upstream auth failures to 502.
    const status = res.status === 401 || res.status === 403 ? 502 : res.status;
    // Strip the upstream vendor name from any text that reaches the client.
    throw new HttpError(status, `Voice service error: ${text.slice(0, 300).replace(/vapi/gi, "voice service")}`);
  }
  return res.json() as Promise<Record<string, unknown>>;
}

/** The authenticated recording kinds Vapi exposes on /call/{id}/{kind}. */
export type VapiRecordingKind =
  | "mono"
  | "stereo"
  | "customer"
  | "assistant"
  | "video";

/** Streams a recording via Vapi's authenticated endpoint (storage.vapi.ai URLs stopped being public in 2026). It 302s to a signed URL; undici correctly drops our auth header on the hop. Null on any failure. */
export async function fetchVapiRecording(
  callId: string,
  kind: VapiRecordingKind = "mono",
  /** Extra request headers — e.g. a `Range` forwarded from a seeking player. */
  extraHeaders?: Record<string, string>,
): Promise<Response | null> {
  if (!integrationsStatus().vapi || !callId) return null;
  try {
    const res = await fetch(`${VAPI_BASE}/call/${callId}/${kind}-recording`, {
      headers: { Authorization: `Bearer ${getEffective("vapi.apiKey")}`, ...extraHeaders },
    });
    return res;
  } catch {
    return null;
  }
}

/** Fetch a Vapi call's recording URL by call id. Returns null on any failure
 *  (unconfigured, unauthorized, not yet processed). Never throws. */
export async function getCallRecordingUrl(callId: string): Promise<string | null> {
  if (!integrationsStatus().vapi || !callId) return null;
  try {
    const res = await fetch(`${VAPI_BASE}/call/${callId}`, {
      headers: { Authorization: `Bearer ${getEffective("vapi.apiKey")}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, any>;
    const artifact = (data.artifact ?? {}) as Record<string, any>;
    const recording = (artifact.recording ?? {}) as Record<string, any>;
    return (
      data.recordingUrl ||
      artifact.recordingUrl ||
      recording.combinedUrl ||
      recording.stereoUrl ||
      recording.mono?.combinedUrl ||
      null
    );
  } catch {
    return null;
  }
}

/** The exact payload the LIVE assistant runs on — prompt, transfer plan, booking
 *  and info-SMS tools, all resolved for this owner.
 *
 *  Shared by `upsertAssistant` (which persists it) and the outbound test call
 *  (which sends it as `assistantOverrides`), so a test call can't quietly drift
 *  from what a real inbound caller reaches. */
export async function buildLiveAssistantPayload(
  config: AgentConfig,
  opts?: { maxDurationSeconds?: number | null; ownerId?: string | null },
): Promise<VapiAssistantPayload> {
  const owner = await assistantOwner(opts?.ownerId);
  // Owner is passed so the country can come from their number when not on the config.
  const systemPrompt = await buildVapiSystemPrompt(config, opts?.ownerId ?? owner?.id);
  const transfer = await getTransferPlan(opts?.ownerId ?? owner?.id ?? null);
  const booking = await getBookingToolConfig(opts?.ownerId ?? owner?.id ?? null);
  const infoSms = await getSmsInfoToolConfig(opts?.ownerId ?? owner?.id ?? null);
  return buildAssistantPayload(config, {
    ...opts,
    owner,
    systemPrompt,
    transfer,
    booking,
    infoSms,
  });
}

/** Create or update the live Vapi assistant for this config. Returns the assistant id. */
export async function upsertAssistant(
  config: AgentConfig,
  existingId?: string | null,
  opts?: { maxDurationSeconds?: number | null; ownerId?: string | null },
): Promise<string> {
  const payload = await buildLiveAssistantPayload(config, opts);
  // Trace what human-transfer config the live assistant is being given, so an
  // "it transferred immediately" report can be checked against what we pushed.
  // Read off the built payload rather than the plan: this is what actually goes to Vapi.
  const pushedTool = payload.model.tools?.find((t) => t.type === "transferCall") ?? null;
  console.log(
    `[transfer] assistant push owner=${opts?.ownerId ?? "?"} ` +
      `enabled=${Boolean(pushedTool)} ` +
      `mode=${pushedTool?.destinations?.[0]?.transferPlan?.mode ?? "none"} ` +
      `destinations=${pushedTool?.destinations?.length ?? 0}`,
  );
  if (existingId) {
    try {
      const updated = await vapiFetch(`/assistant/${existingId}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      return (updated.id as string) ?? existingId;
    } catch (e) {
      // Assistant gone on Vapi: fall through and create a fresh one; the caller persists the new id.
      if (!(e instanceof HttpError) || e.status !== 404) throw e;
    }
  }
  const created = await vapiFetch(`/assistant`, { method: "POST", body: JSON.stringify(payload) });
  return created.id as string;
}

/** Sets or clears the per-call cap. Vapi's field isn't nullable, so "no cap" is written as the 12h maximum — otherwise lowering a cap would be one-way. Never throws. */
export async function setAssistantMaxDuration(
  assistantId: string,
  maxDurationSeconds: number | null,
): Promise<void> {
  if (!integrationsStatus().vapi || !assistantId) return;
  try {
    await vapiFetch(`/assistant/${assistantId}`, {
      method: "PATCH",
      body: JSON.stringify({
        maxDurationSeconds:
          maxDurationSeconds == null
            ? VAPI_MAX_CALL_SECONDS
            : clampCallSeconds(maxDurationSeconds),
      }),
    });
  } catch {
    /* best-effort — the next provision/sync will retry */
  }
}

/** Recording URL from the call record — the end-of-call report often lacks it (processed a few seconds later). Null if not ready. */
export async function getCallRecording(callId: string): Promise<string | null> {
  const data = (await vapiFetch(`/call/${callId}`, { method: "GET" })) as Record<string, unknown>;
  const artifact = (data.artifact ?? {}) as Record<string, unknown>;
  const recording = (artifact.recording ?? {}) as Record<string, unknown>;
  const mono = (recording.mono ?? {}) as Record<string, unknown>;
  const url =
    (data.recordingUrl as string) ||
    (artifact.recordingUrl as string) ||
    (artifact.stereoRecordingUrl as string) ||
    (mono.combinedUrl as string) ||
    (recording.stereoUrl as string) ||
    null;
  return url || null;
}

/** Imports a Twilio number into Vapi and routes it to an assistant. Returns the Vapi phone-number id. */
export async function importTwilioNumber(opts: {
  number: string;
  assistantId: string;
}): Promise<string> {
  // If this number is already imported into Vapi (e.g. an orphan from an earlier
  // run), re-route it to the assistant instead of failing on a duplicate import.
  try {
    const list = (await vapiFetch(`/phone-number`, { method: "GET" })) as unknown as Array<{
      id?: string;
      number?: string;
    }>;
    const existing = Array.isArray(list) ? list.find((p) => p.number === opts.number) : null;
    if (existing?.id) {
      const updated = await vapiFetch(`/phone-number/${existing.id}`, {
        method: "PATCH",
        body: JSON.stringify({ assistantId: opts.assistantId }),
      });
      return (updated.id as string) ?? existing.id;
    }
  } catch {
    /* fall through to a fresh import */
  }
  try {
    const created = await vapiFetch(`/phone-number`, {
      method: "POST",
      body: JSON.stringify({
        provider: "twilio",
        number: opts.number,
        twilioAccountSid: getEffective("twilio.accountSid"),
        twilioAuthToken: getEffective("twilio.authToken"),
        assistantId: opts.assistantId,
      }),
    });
    return created.id as string;
  } catch (e) {
    // A number imported under another Vapi account can't be seen or released with this key.
    const msg = e instanceof Error ? e.message : "";
    if (/already in use by another org/i.test(msg)) {
      throw new HttpError(
        409,
        `${opts.number} is already registered to another account and can't be connected here. Assign a different number to this agent, or release ${opts.number} from the account that currently holds it.`,
      );
    }
    throw e;
  }
}

/** List all Vapi assistant ids in the admin's account. */
export async function listVapiAssistants(): Promise<{ id: string }[]> {
  const list = (await vapiFetch(`/assistant`, { method: "GET" })) as unknown as Array<{ id?: string }>;
  return Array.isArray(list) ? list.filter((a): a is { id: string } => Boolean(a.id)) : [];
}

/** List all Vapi phone numbers (id + E.164 number). */
export async function listVapiPhoneNumbers(): Promise<{ id: string; number: string }[]> {
  const list = (await vapiFetch(`/phone-number`, { method: "GET" })) as unknown as Array<{
    id?: string;
    number?: string;
  }>;
  return Array.isArray(list)
    ? list.filter((p): p is { id: string; number: string } => Boolean(p.id && p.number))
    : [];
}

/** Routes a Vapi number to an assistant; `null` detaches it so the line stops answering (freezing a blocked customer). Never throws. */
export async function setNumberAssistant(
  number: string,
  assistantId: string | null,
): Promise<void> {
  if (!integrationsStatus().vapi || !number) return;
  try {
    const list = (await vapiFetch(`/phone-number`, { method: "GET" })) as unknown as Array<{
      id?: string;
      number?: string;
    }>;
    const match = Array.isArray(list) ? list.find((p) => p.number === number) : null;
    if (!match?.id) return;
    await vapiFetch(`/phone-number/${match.id}`, {
      method: "PATCH",
      body: JSON.stringify({ assistantId }),
    });
  } catch {
    /* best-effort — the cap still limits a blocked call, and renewal re-routes */
  }
}

/** Delete a Vapi phone-number by id (releases it from Vapi). Best-effort. */
export async function deleteVapiPhoneNumber(id: string): Promise<void> {
  try {
    await vapiFetch(`/phone-number/${id}`, { method: "DELETE" });
  } catch {
    /* best-effort */
  }
}

/** Delete a Vapi assistant. Best-effort — never throws. */
export async function deleteAssistant(assistantId: string): Promise<void> {
  try {
    await vapiFetch(`/assistant/${assistantId}`, { method: "DELETE" });
  } catch {
    /* best-effort — the assistant may already be gone */
  }
}

/** Releases a number from Vapi so it can be re-imported for another customer. Never throws. */
export async function releaseVapiNumber(number: string): Promise<void> {
  try {
    const list = (await vapiFetch(`/phone-number`, { method: "GET" })) as unknown as Array<{
      id?: string;
      number?: string;
    }>;
    const match = Array.isArray(list) ? list.find((p) => p.number === number) : null;
    if (match?.id) {
      await vapiFetch(`/phone-number/${match.id}`, { method: "DELETE" });
    }
  } catch {
    /* best-effort */
  }
}

/* ------------------------- Outbound (test) calling ------------------------- */

/** Vapi's id for an E.164 number already imported into the org, or null. */
export async function vapiPhoneNumberIdFor(number: string): Promise<string | null> {
  const clean = (number ?? "").trim();
  if (!clean) return null;
  const list = (await vapiFetch(`/phone-number`, { method: "GET" })) as unknown as Array<{
    id?: string;
    number?: string;
  }>;
  if (!Array.isArray(list)) return null;
  const digits = (s: string) => s.replace(/\D/g, "");
  const match = list.find((p) => p.number && digits(p.number) === digits(clean));
  return match?.id ?? null;
}

/** Import a caller-ID number into Vapi WITHOUT binding an assistant to it.
 *
 *  The platform/brand outbound number is a dialling identity, not a receptionist
 *  line: every outbound call names the assistant it should run, so leaving the
 *  number unbound keeps a shared caller ID from answering one customer's inbound
 *  calls with another customer's agent. `importTwilioNumber` can't be reused —
 *  it requires an assistantId. */
export async function importCallerIdNumber(number: string): Promise<string> {
  const existing = await vapiPhoneNumberIdFor(number).catch(() => null);
  if (existing) return existing;
  const created = await vapiFetch(`/phone-number`, {
    method: "POST",
    body: JSON.stringify({
      provider: "twilio",
      number,
      twilioAccountSid: getEffective("twilio.accountSid"),
      twilioAuthToken: getEffective("twilio.authToken"),
    }),
  });
  return created.id as string;
}

/** Vapi's id for a caller-ID number, importing it on first use. */
export async function ensureVapiPhoneNumberId(number: string): Promise<string> {
  const existing = await vapiPhoneNumberIdFor(number).catch(() => null);
  if (existing) return existing;
  return importCallerIdNumber(number);
}

export interface OutboundCallResult {
  id: string;
  status: string;
}

/** Place an outbound call.
 *
 *  `assistantId` + `assistantOverrides` rather than a transient `assistant`: the
 *  saved assistant is what the end-of-call webhook resolves the owner from, while
 *  the overrides let an unsaved AI-Brain draft be heard on this one call without
 *  rewriting the live agent. Falls back to a transient assistant (attributed via
 *  `metadata.userId`) for an account that has no saved assistant yet. */
export async function createOutboundCall(opts: {
  phoneNumberId: string;
  toNumber: string;
  assistantId?: string | null;
  assistant?: VapiAssistantPayload | null;
  assistantOverrides?: Partial<VapiAssistantPayload> | null;
  metadata?: Record<string, unknown>;
  name?: string;
}): Promise<OutboundCallResult> {
  const body: Record<string, unknown> = {
    phoneNumberId: opts.phoneNumberId,
    customer: { number: opts.toNumber },
    ...(opts.name ? { name: opts.name } : {}),
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  };
  if (opts.assistantId) {
    body.assistantId = opts.assistantId;
    if (opts.assistantOverrides) body.assistantOverrides = opts.assistantOverrides;
  } else if (opts.assistant) {
    body.assistant = opts.assistant;
  } else {
    throw new HttpError(500, "No assistant to run the call with");
  }
  const created = await vapiFetch(`/call`, { method: "POST", body: JSON.stringify(body) });
  return {
    id: String(created.id ?? ""),
    status: String(created.status ?? "queued"),
  };
}

export interface VapiCallStatus {
  id: string;
  /** queued | ringing | in-progress | forwarding | ended */
  status: string;
  endedReason: string;
  durationSec: number;
}

/** Poll one call's live status, so the dialog can say "ringing" vs "answered". */
export async function getCallStatus(callId: string): Promise<VapiCallStatus> {
  const call = await vapiFetch(`/call/${callId}`, { method: "GET" });
  const started = typeof call.startedAt === "string" ? Date.parse(call.startedAt) : NaN;
  const ended = typeof call.endedAt === "string" ? Date.parse(call.endedAt) : NaN;
  const durationSec =
    Number.isFinite(started) && Number.isFinite(ended)
      ? Math.max(0, Math.round((ended - started) / 1000))
      : Number.isFinite(started)
        ? Math.max(0, Math.round((Date.now() - started) / 1000))
        : 0;
  return {
    id: String(call.id ?? callId),
    status: String(call.status ?? ""),
    endedReason: String(call.endedReason ?? ""),
    durationSec,
  };
}

/** End a live call from the server (the "Hang up" button on a phone test call). Best-effort. */
export async function endVapiCall(callId: string): Promise<void> {
  try {
    await vapiFetch(`/call/${callId}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "ended" }),
    });
  } catch {
    /* the caller can always hang up their own handset */
  }
}
