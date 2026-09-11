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

/** How long to keep listening after a caller's speech ends on a number, before
 *  handing the turn to the model. Vapi's default is 0.5s, which is shorter than
 *  the natural pause people leave between the groups of a phone number, so a
 *  dictated number arrives as two or three separate turns. 1.5s comfortably
 *  spans that pause, and it is the same wait Vapi already applies when a turn
 *  ends without punctuation — so it adds no worst case the call didn't have. */
const NUMBER_ENDPOINTING_SECONDS = 1.5;

// Both providers run side-by-side via Vapi — the voice id itself decides which. A
// Deepgram Aura-2 short name (e.g. "theia") → Vapi's "deepgram" provider (model
// "aura-2"); an ElevenLabs voice_id → Vapi's "11labs" provider. providerForVoiceId
// + the resolvers (services/voices.ts) are the single source of truth, so an
// empty/unknown voiceId resolves to the SAME default voice (Sarah) everywhere.

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
    /** Tools exposed to the LLM (transferCall for human handoff + booking function
     *  tools). Always sent — an empty array reliably clears a stale tool on a
     *  PATCH when the owner turns a feature off. */
    tools?: AssistantTool[];
  };
  voice: { provider: string; voiceId: string; model?: string; speed?: number; stability?: number };
  /** Speech-to-text. Omitted → Vapi's default (English). Multilingual agents set
   *  Deepgram nova-3 with language "multi" so the caller's speech is transcribed
   *  correctly when they code-switch away from English mid-call. `fallbackPlan`
   *  carries the admin-configured backup STT(s) tried when the primary fails. */
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
  /** Deterministic hang-up backstop: if the assistant SPEAKS one of these
   *  phrases, Vapi ends the call even when the LLM forgets the endCall tool.
   *  Always sent — [] reliably clears stale phrases on a PATCH when the owner
   *  turns hang-up off. */
  endCallPhrases: string[];
  recordingEnabled: boolean;
  artifactPlan: { recordingEnabled: boolean; recordingFormat: "wav;l16" | "mp3" };
  /** Tells Vapi to extract structured fields (caller name, callback number,
   *  email) from the conversation into `analysis.structuredData` on the
   *  end-of-call report. Inbound calls carry no `customer.name`, so this is the
   *  only reliable source for the caller's name pushed to the CRM. */
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
  /** How long Vapi keeps listening before handing the turn to the model. Only
   *  the number case is set — a caller reading a phone number in groups pauses
   *  mid-number, and Vapi's 0.5s default treats each group as a finished turn. */
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

/** Vapi-dashboard-only label: "<spoken name> - <business or email user> #<id6>".
 *  Vapi's `name` field is never seen by the LLM (only `model.messages` +
 *  `firstMessage` are), so tagging it with the owner lets the admin tell agents
 *  apart on the Vapi dashboard while the agent still just says "Mark" on calls.
 *  Without owner context it returns the plain label (existing behavior). */
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
    // Plan gate BEFORE any of the config is read. Attaching the tool is what
    // actually gives a caller the handoff, so a plan without Call Transfer has
    // to lose it here — otherwise a downgrade only takes effect whenever the
    // owner next happens to save the page, and until then they keep a paid
    // feature on live calls.
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
      // Clamped to the plan as a backstop. Writes are capped already, but rows
      // can predate the limits (or an admin can lower a plan under live users),
      // and the ordering is stable, so the AI always offers the same first N.
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

/** Live booking context for an owner: whether booking is active (Google connected
 *  AND not paused) and the plain-English availability block to constrain bookings.
 *  Availability is deliberately SEPARATE from the AI Brain's general Business Hours
 *  — it only governs bookings and only exists while connected. Best-effort. */
export interface BookingContext {
  enabled: boolean;
}

/** Whether this owner has live Google Calendar booking — connected AND not paused.
 *  The AI already knows the business (master prompt + services) and its hours
 *  (Business Hours block), so no extra booking config is needed. Best-effort. */
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

/** The system prompt a live assistant runs on: the owner's manually edited
 *  prompt when frozen, else a fresh compile on the compact wire scaffold. This
 *  is the pre-summarization base — pass it through summarizePromptForVapi
 *  before pushing (see upsertAssistant / the test-token route). */
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

/** Resolve the customer's ISO country for the regional style: the value stored on
 *  the config (captured at onboarding), else derived from their AI number, else
 *  their mobile. Guarantees the regional style is applied whenever the country is
 *  knowable at all — regardless of which code path triggered the assistant push. */
async function resolveAssistantCountry(config: AgentConfig, ownerId?: string | null): Promise<string> {
  const explicit = normalizeCountry(config.identity.country);
  if (explicit) return explicit;
  if (!ownerId) return "";
  const profile = await tenantForUser(ownerId)
    .then((db) => db.profile.findUnique({ where: { userId: ownerId }, select: { receptionistNumber: true, mobile: true } }))
    .catch(() => null);
  return isoCountryForPhone(profile?.receptionistNumber) || isoCountryForPhone(profile?.mobile);
}

/** The final system prompt pushed to the live assistant: the LLM-summarized wire
 *  prompt with the caller's REGIONAL STYLE appended. This is the SINGLE place the
 *  regional block is added, and every assistant push goes through it, so the block
 *  is mandatory whenever the country is knowable. The style is added AFTER
 *  summarization on purpose — the exact local phrasing ("no worries", "too easy")
 *  must survive verbatim, and this way it applies uniformly even to manually
 *  edited (frozen) prompts without polluting the customer's editable AI Brain. */
export async function buildVapiSystemPrompt(config: AgentConfig, ownerId?: string | null): Promise<string> {
  const summarized = await summarizePromptForVapi(baseSystemPrompt(config));
  const iso = await resolveAssistantCountry(config, ownerId);
  const section = regionalStyleSection(getCountryStyle(iso));
  const withStyle = section ? `${summarized.trimEnd()}\n\n${section}` : summarized;
  // HOW the agent may speak (reply length, one question at a time, how to sign
  // off) is a platform guarantee, not per-customer content — so it is stamped on
  // here, verbatim, for EVERY assistant. Doing it at this point is what makes it
  // universal: an owner who hand-edits their master prompt freezes it, and
  // baseSystemPrompt then serves that frozen text, so a template change alone
  // never reaches them. Appending after summarization also puts the rules beyond
  // the summarizer's reach. Any existing copy is stripped first so a frozen or
  // reworded version can't contradict this one, and it goes last because these
  // are the rules the model most needs in recent context.
  // WIRE_NUMBER_RULES rides along for the same reason: taking a caller's number
  // without making them repeat it is a platform guarantee, and a frozen prompt
  // would otherwise never receive it.
  return `${stripHowMuchToSay(withStyle)}\n\n${WIRE_BEHAVIOUR_RULES}\n\n${WIRE_NUMBER_RULES}`;
}

/** The mini "transfer assistant" Vapi runs on the OPERATOR leg during a
 *  `warm-transfer-experimental` transfer. It calls the human, announces the
 *  caller, and connects them only if the human agrees — this is what actually
 *  gates the bridge on a real answer (instead of connecting immediately). */
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

/** Vapi warm-transfer plan. `warm-transfer-experimental` holds the caller,
 *  spins up `transferAssistant` on a separate leg to the human, and only bridges
 *  once that assistant calls its success tool — true answer gating. */
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

/** Tool-level spoken messages (NOT per-destination — Vapi only honours these at
 *  the tool root). `request-start` is spoken to the caller as the transfer
 *  begins; `request-failed` is the end message when it can't connect. */
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

/** A Vapi custom "function" tool backed by our server. When the LLM calls it, Vapi
 *  POSTs the invocation to `server.url` and speaks the returned `result` back into
 *  the conversation. Used for the booking tools (checkAvailability,
 *  createBooking, cancel/reschedule). */
export interface VapiFunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      /** `enum` closes a parameter to a fixed set of values — the model can only
       *  pick values we published, which is how sendInfoSms stays constrained to
       *  the owner's own catalogue (on the parameter itself, or on an array's
       *  `items` for a multi-select like `topics`). */
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

/** Enabled departments with a valid dial number, in display order. The single
 *  source of truth for "does this owner use department routing?" — an empty
 *  result means fall back to the one-number setup. */
function activeDepartments(plan: TransferPlan): TransferDepartmentPlan[] {
  return (plan.departments ?? [])
    .map((d) => ({ ...d, number: toDialE164(d.number) }))
    .filter((d) => d.name.trim() && d.number.length >= 7);
}

/** Default LLM for the operator-leg transfer assistant. Kept capable + tool-
 *  calling-friendly; overridden with the account's agent LLM when available. */
const DEFAULT_TRANSFER_LLM = { provider: "openai", model: "gpt-4o" };

/** One warm-transfer destination using `warm-transfer-experimental`: Vapi holds
 *  the caller, spins up a mini assistant on a SEPARATE leg to `number`, which
 *  announces the caller and only connects them if the human agrees. If the human
 *  doesn't answer / declines, the tool-level `request-failed` end message plays.
 *  `label` names the line for the operator announcement (a department name, or
 *  "our team" for the single number). */
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

/** Build the Vapi transferCall tool from the owner's transfer config. When
 *  departments are configured, each becomes a warm-transfer destination the LLM
 *  routes to by name; otherwise the single fallback number is used. Returns null
 *  when transfer is off or no valid number/department exists. The `llm` runs the
 *  operator-leg transfer assistant (defaults to a capable model). */
export function buildTransferTool(
  plan: TransferPlan | null | undefined,
  llm: { provider: string; model: string } = DEFAULT_TRANSFER_LLM,
): VapiTool | null {
  if (!plan?.enabled) return null;

  // Department routing is the ONLY transfer path: the caller is connected solely
  // to the departments the owner currently has configured. With no active
  // department (none configured, or they were all deleted) there is nothing to
  // dial — return null so no transferCall tool (and no transfer prompt) is pushed
  // to the assistant. This is deliberate: we do NOT fall back to the legacy
  // single `transferNumber`, so a deleted department can never keep connecting
  // callers via a stale hidden number.
  const depts = activeDepartments(plan);
  if (!depts.length) return null;

  // Vapi's transferCall exposes a single tool-level `request-failed` message,
  // not one per destination — so the end message that plays when the human
  // can't be reached is taken from the first active department's message as the
  // tool-level default. Each destination keeps its OWN ring timeout.
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
      // Do NOT hang up after the "couldn't connect" line — hand control back to the
      // AI so it can take a message (name + reason), tagged with the department the
      // caller had selected. The message-taking behaviour is driven by
      // transferPromptSection's "IF THE TRANSFER CAN'T CONNECT" block.
      { type: "request-failed", content: primaryFallback, endCallAfterSpokenEnabled: false },
    ],
  };
}

/** The prompt block that gives the AI the intelligence to detect a human-handoff
 *  request and use the transfer tool — plus what to say when it can't connect.
 *  With departments configured, it tells the AI to ask which department the
 *  caller needs and route to the matching transferCall destination. */
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

/** Build the Vapi assistant payload from the structured agent config.
 *  `maxDurationSeconds` caps each call to the owner's remaining minutes.
 *  `systemPrompt` overrides the compiled prompt (used to pass the
 *  LLM-summarized wire copy). `transfer` wires the human-handoff tool + prompt. */
/** The booking instructions grafted onto the live prompt when the owner has
 *  Google Calendar connected + booking enabled. Kept out of the customer's
 *  editable AI Brain (like the transfer/WhatsApp blocks) — it's a live-agent
 *  behaviour derived from their integration state, not prompt content.
 *
 *  `availability` is the owner's BOOKING-specific hours (may be blank). It is
 *  deliberately distinct from the general Business Hours block: this section only
 *  constrains when the AI may SCHEDULE, and does not change how any other call is
 *  handled — general enquiries, messages and questions are answered as normal at
 *  any time. */
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

/** The booking behaviour + live tools for an owner, resolved from their booking
 *  config. Shared by the live assistant (upsertAssistant), the web-test token
 *  route, and the frontend tool-config endpoint so all three behave identically.
 *  `enabled` is false (and tools empty) when there's no public server URL to point
 *  tools at. */
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

/** Build the Vapi booking function tools for an owner. The availability / create /
 *  cancel / reschedule tools are added only when the owner may auto-book (Google
 *  Calendar connected + auto-booking on). Each tool posts to our dispatcher,
 *  stamped with `?uid=<ownerId>` so it resolves the business (web test calls run a
 *  transient assistant with no persisted id). */
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

/** Resolve the full booking behaviour (prompt + tools) for an owner. Returns a
 *  disabled config when there's no public server URL (tools can't be reached) or
 *  nothing to offer. Best-effort. */
export async function getBookingToolConfig(ownerId: string | null): Promise<BookingToolConfig> {
  if (!ownerId) return BOOKING_DISABLED;
  const base = webhookServerUrl();
  try {
    const stored = await getBookingConfig(ownerId);
    // INVARIANT: the prompt must only ever describe abilities the AI actually
    // has. With no public server URL the booking tools would be unreachable, so
    // drop canAutoBook too — otherwise the prompt would tell the AI to call a
    // createBooking tool that isn't attached. What's left is take-a-message,
    // which needs no callback at all.
    const config = base ? stored : { ...stored, canAutoBook: false };
    const tools = base ? buildBookingTools(config, ownerId, base) : [];
    // The booking prompt section always ships (take-a-message needs no tools);
    // the tools array is simply empty when the AI can't auto-book.
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

/* ------------------------------------------------------------------ *
 *  "Text Info to Callers" — the sendInfoSms tool.
 *
 *  One tool, not one per item: the owner's enabled topics become an `enum` on a
 *  `topics` array parameter. Ten toggles would otherwise mean ten tools, which
 *  degrades the model's routing and bloats every assistant sync. Passing an array
 *  also lets a caller who asks for several things at once get them in ONE text.
 *  The message body is NOT a parameter — it's rendered server-side from the
 *  owner's own template, so a caller can never talk the agent into texting
 *  arbitrary text.
 * ------------------------------------------------------------------ */

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

/** Resolve the owner's SMS-on-request behaviour (prompt + live tool). Disabled
 *  when the owner has it off, nothing can render, or there's no public server
 *  URL for the tool to call back on. Best-effort. */
export async function getSmsInfoToolConfig(ownerId: string | null): Promise<SmsInfoToolConfig> {
  if (!ownerId) return SMS_INFO_DISABLED;
  const base = webhookServerUrl();
  if (!base) return SMS_INFO_DISABLED; // no reachable server → don't attach the tool
  try {
    // Plan gate, enforced here and not only in the UI: the owner's toggle can
    // outlive their entitlement (they had it, then moved to a plan without it),
    // and without this the tool would still be attached to their live assistant.
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

/** Sign-off phrases that hard-end the call when the assistant says them (the
 *  endCallPhrases backstop). Deliberately excludes anything that appears in a
 *  normal greeting (e.g. "thanks for calling") so a call can't end at hello.
 *
 *  MUST contain the sign-off the prompt tells the agent to use. When it didn't,
 *  the agent worked out that its scripted warm sign-off left the line open and
 *  fell back to a bare "Goodbye." — the one phrase here that actually hung up. */
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

/** The stock CLOSING block used to say "Don't hang up first — wait for a clear
 *  end signal", which flatly contradicts the ENDING THE CALL block grafted on
 *  when hang-up is allowed. Given both, the agent signs off ("Take care.") and
 *  leaves the line open — the reported bug. The templates no longer say it, but
 *  frozen template snapshots, admin overrides and hand-edited master prompts
 *  still do, so strip that one sentence from the wire prompt when hang-up is on.
 *  The rest of CLOSING is untouched. */
const DONT_HANG_UP_FIRST_RE = /\s*Don['’]t hang up first[^.]*\.\s*/gi;

export function stripDontHangUpFirst(prompt: string): string {
  const stripped = prompt.replace(DONT_HANG_UP_FIRST_RE, " ");
  return stripped === prompt ? prompt : stripped.replace(/[ \t]+\n/g, "\n").trimEnd();
}

/** Grafted onto the live prompt when hang-up is allowed (like the transfer and
 *  booking blocks) — teaches the LLM to actually invoke the endCall tool after
 *  signing off, instead of leaving the line open until the silence timeout. */
export function endCallPromptSection(): string {
  return [
    "## ENDING THE CALL",
    "When the conversation is clearly over — the caller says goodbye, \"no thanks\", \"that's all\", or declines more help after you've wrapped up — say EXACTLY this, word for word:",
    "\"No worries at all — thanks for calling, have a great day!\"",
    "Then IMMEDIATELY use the endCall tool to hang up. Say that whole sentence — never shorten it to a single word, never swap it for a shorter sign-off, and never add anything after it.",
    "Never leave the line open waiting for the caller to hang up first, and never ask another question after the caller has said goodbye.",
  ].join("\n");
}

export function buildAssistantPayload(
  config: AgentConfig,
  opts?: {
    maxDurationSeconds?: number | null;
    owner?: AssistantOwner | null;
    systemPrompt?: string;
    transfer?: TransferPlan | null;
    /** Booking behaviour + live function tools (from getBookingToolConfig). When
     *  the owner can auto-book, grafts the booking prompt + attaches the
     *  checkAvailability/createBooking/cancel/reschedule tools. */
    booking?: BookingToolConfig | null;
    /** "Text Info to Callers" behaviour + the sendInfoSms tool (from
     *  getSmsInfoToolConfig). */
    infoSms?: SmsInfoToolConfig | null;
  },
): VapiAssistantPayload {
  const basePrompt = opts?.systemPrompt?.trim() || baseSystemPrompt(config);
  // Give the LLM the human-handoff instructions whenever transfer is live, so it
  // knows WHEN to invoke the tool we attach below.
  // The operator-leg transfer assistant MUST reliably call its
  // transferSuccessful/transferCancel tools to gate the bridge — so it runs on a
  // known tool-calling-solid model (OpenAI gpt-4o, Vapi's documented default),
  // NOT the account's conversational agent LLM (which may be xai/grok etc. and
  // fail the tool calls, causing Vapi to fall back to an immediate blind bridge).
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
  // Teach the AI to actually hang up after a goodbye — only when the endCall
  // tool exists (allowHangUp), so we never instruct a tool that isn't there.
  // Drop any leftover "don't hang up first" line first, or the two instructions
  // cancel out and the agent politely waits for the caller to hang up instead.
  const systemPrompt = config.advanced.allowHangUp
    ? `${stripDontHangUpFirst(withInfoSms).trimEnd()}\n\n${endCallPromptSection()}`
    : withInfoSms;

  // Use the assistant name the user set (so renaming in the AI Brain syncs to
  // Vapi); fall back to "{Business} Receptionist", then a generic label.
  // Vapi caps the assistant `name` at 40 chars — a longer name (e.g. a verbose
  // scraped business title from Amazon/Flipkart) makes the create/update 400 and
  // no assistant is provisioned. Trim to fit, dropping any partial trailing word.
  const businessName = config.identity.businessName?.trim();
  const assistantLabel = (
    config.identity.assistantName?.trim() ||
    (businessName ? `${businessName} Receptionist` : "") ||
    "Receptionist"
  )
    .slice(0, NAME_MAX)
    .trim();

  // Always greet first with a real message — an empty greetingMessage left the
  // assistant silent on connect (it waited for the caller). resolveGreeting also
  // re-derives a generated greeting still carrying a previous business name, so a
  // rename reaches live calls even for configs saved before that fix.
  const greeting = resolveGreeting(config.identity.greetingMessage, businessName);

  // Voice provider is per-agent + sticky: use the provider stamped on the config,
  // else derive it from the stored voiceId (so an existing ElevenLabs agent keeps
  // ElevenLabs even after the admin flips the global toggle back). Deepgram Aura-2
  // has no speed/stability knobs (Advanced sliders don't apply); ElevenLabs honours
  // them. Both are proxied by Vapi.
  // The LLM is the admin-selected platform default (Admin → Settings → Default
  // Agent Model). Falls back to the built-in default when unset. Stamped on every
  // create AND sync, so changing it rolls out to existing assistants on their next
  // AI-Brain save/sync too.
  const llm = getAgentLlm();

  // Multilingual (plan-gated, picked in the AI Brain). Non-empty → the whole
  // voice pipeline must handle non-English speech, not just the prompt:
  //  - STT: Deepgram nova-3 `language: "multi"` transcribes code-switching
  //    (English ↔ the caller's language) — without it Hindi speech arrives as
  //    garbled English and the LLM can never follow the caller.
  //  - TTS: Deepgram Aura-2 speaks English only, so multilingual agents always
  //    use ElevenLabs (eleven_turbo_v2_5 covers every supported language).
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
    // Always sent (never omitted): a PATCH with the key missing leaves the old
    // transcriber in place, so an agent that toggled languages on/off would be
    // stuck with a stale language setting forever.
    // Chosen from the enabled languages — Deepgram for the set it covers, Google's
    // multilingual model for Punjabi/Mandarin, which Deepgram's "multi" can't hear.
    // The admin's fallback plan is grafted on when set — only with backups that can
    // actually hear this agent's language tier (see buildTranscriberFallbackPlan).
    transcriber: (() => {
      const primary = transcriberFor(languages);
      // Deepgram accuracy boosts: smart formatting (numbers/addresses) always, and
      // keyterm prompting with the business's own vocabulary — nova-3 supports
      // keyterm for English only, so it's attached only in "en" mode.
      const keyterm =
        primary.provider === "deepgram" && primary.language === "en"
          ? transcriberKeyterms(config)
          : [];
      // `numerals` is what actually turns a spoken "eight five eight zero four"
      // into "85804". smartFormat alone does NOT do it — Deepgram's own note on
      // that flag is that it "can sometimes format numbers as times", which is
      // why the dedicated flag exists. Without it the LLM receives the caller's
      // phone number as English words and has to reassemble it, which is where
      // the endless "sorry, can you repeat that?" loops came from.
      // Applied to every Deepgram config, not just "en": Deepgram supports
      // numerals in most of the nova-3 multi set too. Hindi and Japanese are the
      // exceptions — Deepgram documents them as unsupported and ignores the flag
      // rather than erroring, so those agents are no worse off than before.
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
      // Always sent so turning transfer/booking/SMS OFF (→ fewer/no tools)
      // reliably strips a stale tool on the PATCH, the same way the transcriber is
      // always sent. transferCall first, then booking, then sendInfoSms.
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
    // MP3 rather than Vapi's default `wav;l16`. A one-minute call is ~1 MB
    // instead of ~10, and owners forward these recordings to customers and
    // insurers who expect a file every phone and email client will just play.
    // Nothing downstream hardcodes the format — the download names itself from
    // the upstream content-type — so old WAV recordings keep working untouched.
    artifactPlan: { recordingEnabled: true, recordingFormat: "mp3" },
    // Barge-in: the moment the caller speaks, stop talking and let them take over
    // (don't finish the sentence first). numWords:0 → yield on the first word.
    stopSpeakingPlan: { numWords: 0, voiceSeconds: 0.2, backoffSeconds: 1 },
    // Callers read a phone number in chunks — "eight five eight zero four…
    // five six five nine six" — and the transcriber punctuates each chunk as if
    // the thought were finished. At Vapi's 0.5s default the agent answers half a
    // number and then asks for it again, which is exactly the re-confirm loop
    // owners were hearing. Only the number case is stretched; the punctuation
    // and no-punctuation timings keep Vapi's defaults so ordinary replies stay
    // as snappy as before. The cost is a beat of extra silence when a caller's
    // turn genuinely ends on a number ("yeah, 3 o'clock") — worth it against
    // making them recite their number twice.
    startSpeakingPlan: {
      transcriptionEndpointingPlan: { onNumberSeconds: NUMBER_ENDPOINTING_SECONDS },
    },
    // Live control channel (call.monitor.controlUrl). Vapi defaults this on, but
    // the pre-cap wrap-up (services/callWrapUp.ts) is entirely dependent on it —
    // an account-level default flipping off would silently turn every capped call
    // back into a mid-sentence hang-up, so it's stated rather than assumed.
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
            // Only the two categories that genuinely need judgement are asked
            // for. lead-vs-enquiry is decided server-side from whether the
            // caller volunteered contact details, and "booking" is decided from
            // whether an appointment was actually created — never from what was
            // said, because "I'd like to book" is not a booking. See
            // lib/callIntent.ts.
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
    // Route post-call events to our webhook so each call triggers the owner email
    // + call log. Uses the public API base (VAPI_SERVER_URL, falling back to
    // PUBLIC_API_URL) — set this in prod (e.g. the Render URL) or real inbound
    // phone calls never get logged.
    ...(webhookServerUrl()
      ? {
          server: {
            url: `${webhookServerUrl()}/api/calls/webhook/vapi`,
            // Shared secret Vapi echoes back in the `x-vapi-secret` header on
            // every server message, so our webhook can prove the event really
            // came from Vapi and not a forged "call ended" POST (which would
            // otherwise drain a customer's minutes / trigger a charge). Omitted
            // when unset so local/dev keeps working; verified in calls.routes.ts.
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

/** Public base URL Vapi posts call events to (and booking tools call back on),
 *  trimmed of a trailing slash. Empty string when no public URL is configured
 *  (e.g. local dev w/o a tunnel) — callers must not attach live tools then. */
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

/**
 * Stream a call's recording straight from Vapi's authenticated download endpoint.
 * As of the 2026 recording-auth change, `storage.vapi.ai` URLs are no longer
 * publicly fetchable — audio must be pulled via `GET /call/{id}/{kind}-recording`
 * with the API key. That endpoint 302-redirects to a short-lived signed URL;
 * `fetch` follows it automatically (undici drops our Authorization header on the
 * cross-origin hop, which is correct — the signed URL needs no auth). Returns the
 * upstream Response so the caller can stream/proxy it. Never throws — returns null
 * when Vapi isn't configured, the id is missing, or the fetch errors.
 */
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

/** Create or update the live Vapi assistant for this config. Returns the assistant id. */
export async function upsertAssistant(
  config: AgentConfig,
  existingId?: string | null,
  opts?: { maxDurationSeconds?: number | null; ownerId?: string | null },
): Promise<string> {
  const owner = await assistantOwner(opts?.ownerId);
  // Compress the prompt for the wire (invisible to the customer — their AI Brain
  // keeps the full prompt) and append the caller's regional style verbatim. Pass
  // the owner so the country can be derived from their number when not on config.
  const systemPrompt = await buildVapiSystemPrompt(config, opts?.ownerId ?? owner?.id);
  // Wire the human-transfer tool + prompt from the owner's live settings so a
  // real inbound caller who asks for a person is bridged to their support line.
  const transfer = await getTransferPlan(opts?.ownerId ?? owner?.id ?? null);
  // Website-first booking: the AI always pitches + texts the website when a site
  // exists, and can auto-book only when the owner's toggle is on AND Google is
  // connected. Resolves the live function tools (pointed at our dispatcher with the
  // owner id stamped in) + the booking prompt. Empty when no public server URL.
  const booking = await getBookingToolConfig(opts?.ownerId ?? owner?.id ?? null);
  // "Text Info to Callers": the caller asks for the website/email/address and the
  // AI offers to text it. Resolves the owner's enabled topics into one tool
  // pointed at our dispatcher. Empty when the owner has it off.
  const infoSms = await getSmsInfoToolConfig(opts?.ownerId ?? owner?.id ?? null);
  const payload = buildAssistantPayload(config, {
    ...opts,
    owner,
    systemPrompt,
    transfer,
    booking,
    infoSms,
  });
  // Trace what human-transfer config the live assistant is being given, so an
  // "it transferred immediately" report can be checked against what we pushed.
  const pushedTool = payload.model.tools?.find((t) => t.type === "transferCall") ?? null;
  console.log(
    `[transfer] assistant push owner=${opts?.ownerId ?? owner?.id ?? "?"} ` +
      `enabled=${transfer.enabled} number=${transfer.transferNumber || "-"} ` +
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
      // The stored assistant no longer exists on Vapi (deleted/recreated) — don't
      // fail the whole flow. Fall through to create a fresh one; the caller persists
      // the new id so numbers bind to a real, routable assistant (not a dead id).
      if (!(e instanceof HttpError) || e.status !== 404) throw e;
    }
  }
  const created = await vapiFetch(`/assistant`, { method: "POST", body: JSON.stringify(payload) });
  return created.id as string;
}

/**
 * Patch only a live assistant's per-call duration cap (seconds). Called as a
 * user's remaining minutes change so real inbound calls are cut at the limit.
 * Best-effort — never throws.
 */
/**
 * Set (or clear) an assistant's per-call cap.
 *
 * `null` means "no cap" — but Vapi's `maxDurationSeconds` is not nullable, so
 * removing a cap is expressed as its maximum (12 hours), which no real call
 * reaches. This matters: without it, lowering a cap would be one-way. An account
 * capped while a platform ceiling was on would stay capped after the admin
 * switched the ceiling off, because there would be no value to write back.
 */
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

/**
 * Fetch a call's recording URL from Vapi. Web-call recordings are processed a
 * few seconds after the call ends, so the live end-of-call report often lacks
 * it — this reads it back from the call record. Returns null if not ready.
 */
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

/**
 * Import a Twilio number into Vapi and route it to an assistant. Uses the
 * admin's Twilio credentials. Returns the Vapi phone-number id.
 */
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
    // Each phone number can belong to a single voice-provider account. If it was
    // imported under a different account (e.g. an earlier API key / a teammate's
    // account), this key can't see it to release it — so the import 400s with
    // "already in use by another org". Surface a clean message instead of raw JSON.
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

/**
 * Route (or un-route) an already-imported Vapi number to an assistant. Pass
 * `null` to detach the assistant so the number STOPS answering incoming calls —
 * used to freeze a blocked customer's line. Best-effort, never throws.
 */
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

/**
 * Release a Twilio number from Vapi so it can be re-imported for another
 * customer (returns it to the assignable pool). Best-effort — never throws.
 */
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
