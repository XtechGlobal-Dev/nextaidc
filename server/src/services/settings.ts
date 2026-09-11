import { prisma } from "../prisma.js";
import { encryptSecret, decryptSecret } from "../lib/crypto.js";
import { currentBrandId } from "../lib/brandContext.js";
import { brandCardRequired } from "./brandSetup.js";
import {
  DEFAULT_AGENT_LLM,
  DEFAULT_PROMPT_TEMPLATE,
  DEFAULT_PROMPT_TEMPLATE_SHORT,
} from "../lib/agentConfig.js";
import { BUILTIN_COUNTRY_STYLES, normalizeCountry } from "../lib/countryStyles.js";
import {
  BUILTIN_INDUSTRIES,
  industryInList,
  normalizeIndustryWhitespace,
} from "../lib/industries.js";

/* ------------------------------------------------------------------ *
 *  Platform settings — integration API keys.
 *  Effective value = DB override → env fallback. Kept in an in-memory
 *  cache (loaded at startup, refreshed on save) so services read it
 *  synchronously. Secrets are encrypted at rest and never returned raw.
 * ------------------------------------------------------------------ */

export interface FieldDef {
  key: string; // e.g. "vapi.apiKey"
  label: string;
  secret: boolean;
  envVar?: string; // env fallback
  placeholder?: string;
}
export interface IntegrationDef {
  id: string;
  name: string;
  description: string;
  /** Field keys that must be set for the integration to count as "connected". */
  required: string[];
  fields: FieldDef[];
}

export const INTEGRATIONS: IntegrationDef[] = [
  {
    id: "vapi",
    name: "Vapi",
    description: "Voice AI orchestration",
    required: ["vapi.apiKey"],
    fields: [
      { key: "vapi.apiKey", label: "Private Key", secret: true, envVar: "VAPI_API_KEY" },
      { key: "vapi.publicKey", label: "Public Key", secret: false, envVar: "VAPI_PUBLIC_KEY", placeholder: "for in-browser test calls" },
      { key: "vapi.webhookSecret", label: "Webhook Secret", secret: true, envVar: "VAPI_WEBHOOK_SECRET", placeholder: "shared secret Vapi returns as the x-vapi-secret header on every call webhook — set the SAME value in Vapi org settings" },
    ],
  },
  {
    id: "deepgram",
    name: "Deepgram",
    description: "Text-to-speech voice samples for the landing page, onboarding & AI-Brain preview",
    required: ["deepgram.apiKey"],
    fields: [
      { key: "deepgram.apiKey", label: "API Key", secret: true, envVar: "DEEPGRAM_API_KEY" },
    ],
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    description: "Alternative TTS voice provider — flip the Admin toggle to switch every voice to ElevenLabs if Deepgram quality drops",
    required: ["elevenlabs.apiKey"],
    fields: [
      { key: "elevenlabs.apiKey", label: "API Key", secret: true, envVar: "ELEVENLABS_API_KEY" },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    description: "LLM for the support chat assistant",
    required: ["openai.apiKey"],
    fields: [
      { key: "openai.apiKey", label: "API Key", secret: true, envVar: "OPENAI_API_KEY" },
      { key: "openai.model", label: "Model", secret: false, envVar: "OPENAI_MODEL", placeholder: "gpt-5" },
    ],
  },
  // Stripe is intentionally NOT listed here — it's configured via the server
  // environment only (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET), never from the
  // admin Settings UI. See services/stripe.ts, which reads env directly.
  {
    id: "email",
    name: "Email (SMTP)",
    description: "Transactional email — works with any SMTP provider (incl. SendGrid)",
    required: ["smtp.host"],
    fields: [
      { key: "smtp.host", label: "SMTP Host", secret: false, envVar: "SMTP_HOST", placeholder: "smtp.sendgrid.net" },
      { key: "smtp.port", label: "SMTP Port", secret: false, envVar: "SMTP_PORT", placeholder: "587" },
      { key: "smtp.user", label: "Username", secret: false, envVar: "SMTP_USER", placeholder: "apikey" },
      { key: "smtp.pass", label: "Password", secret: true, envVar: "SMTP_PASS" },
      { key: "smtp.from", label: "From Address", secret: false, envVar: "SMTP_FROM", placeholder: "hello22.ai <support@hello22.ai>" },
      { key: "smtp.supportInbox", label: "Support Handoff Inbox", secret: false, envVar: "SUPPORT_INBOX_EMAIL", placeholder: "where chat handoffs are emailed — blank = From Address" },
    ],
  },
  {
    id: "google",
    name: "Google Calendar",
    description: "OAuth for calendar event creation",
    required: ["google.clientId", "google.clientSecret"],
    fields: [
      { key: "google.clientId", label: "Client ID", secret: false, envVar: "GOOGLE_CLIENT_ID" },
      { key: "google.clientSecret", label: "Client Secret", secret: true, envVar: "GOOGLE_CLIENT_SECRET" },
      { key: "google.redirectUri", label: "Redirect URI", secret: false, envVar: "GOOGLE_REDIRECT_URI", placeholder: "http://localhost:4000/api/google/callback" },
    ],
  },
  {
    id: "twilio",
    name: "Twilio",
    description: "SMS & phone numbers",
    required: ["twilio.accountSid", "twilio.authToken", "twilio.fromNumber"],
    fields: [
      { key: "twilio.accountSid", label: "Account SID", secret: false, envVar: "TWILIO_ACCOUNT_SID" },
      { key: "twilio.authToken", label: "Auth Token", secret: true, envVar: "TWILIO_AUTH_TOKEN" },
      { key: "twilio.fromNumber", label: "From Number", secret: false, envVar: "TWILIO_FROM_NUMBER" },
    ],
  },
  {
    id: "whatsapp",
    name: "WhatsApp (Meta)",
    description: "WhatsApp Business Cloud API — post-call summaries and follow-ups via Meta",
    required: ["whatsapp.accessToken", "whatsapp.phoneNumberId"],
    fields: [
      { key: "whatsapp.phoneNumberId", label: "Phone Number ID", secret: false, envVar: "WHATSAPP_PHONE_NUMBER_ID", placeholder: "from Meta Business → WhatsApp → API Setup" },
      { key: "whatsapp.businessAccountId", label: "WhatsApp Business Account ID", secret: false, envVar: "WHATSAPP_BUSINESS_ACCOUNT_ID", placeholder: "WABA ID from Meta → WhatsApp → API Setup (optional)" },
      { key: "whatsapp.accessToken", label: "Permanent Access Token", secret: true, envVar: "WHATSAPP_ACCESS_TOKEN", placeholder: "System-user permanent token (EAA…)" },
      { key: "whatsapp.verifyToken", label: "Webhook Verify Token (inbound — optional)", secret: true, envVar: "WHATSAPP_VERIFY_TOKEN", placeholder: "any secret string — paste the same value into Meta → Webhooks → Verify token" },
      { key: "whatsapp.appSecret", label: "App Secret (inbound — optional)", secret: true, envVar: "WHATSAPP_APP_SECRET", placeholder: "Meta → App settings → Basic → App secret (verifies inbound webhook signatures)" },
      { key: "whatsapp.agentUserId", label: "Answering Agent (User ID)", secret: false, envVar: "WHATSAPP_AGENT_USER_ID", placeholder: "blank = most recent approved agent answers inbound WhatsApp" },
      { key: "whatsapp.callTemplate", label: "Call Summary Template Name", secret: false, envVar: "WHATSAPP_CALL_TEMPLATE", placeholder: "e.g. call_notification — leave blank to try freeform first" },
    ],
  },
  {
    id: "perfex",
    name: "Nexleon CRM",
    description: "Central lead management — all call leads from all users are pushed here",
    required: ["perfex.url", "perfex.formKey"],
    fields: [
      { key: "perfex.url", label: "Nexleon CRM URL", secret: false, envVar: "PERFEX_CRM_URL", placeholder: "https://crm.nexleon.com" },
      { key: "perfex.formKey", label: "Web-to-Lead Form Key", secret: false, envVar: "PERFEX_CRM_FORM_KEY", placeholder: "from Leads → Web To Lead" },
    ],
  },
];

const ALL_FIELDS = new Map<string, FieldDef>();
for (const i of INTEGRATIONS) for (const f of i.fields) ALL_FIELDS.set(f.key, f);

const effective: Record<string, string> = {};
/** Keys whose effective value came from a DB row (i.e. an admin saved it). */
const dbKeys = new Set<string>();

/** (Re)load effective settings: env defaults overlaid with DB values. Retries a
 *  few times so a cold/​waking DB (e.g. Neon scale-to-zero) at boot doesn't leave
 *  every integration showing "not configured". */
export async function loadSettings(): Promise<void> {
  dbKeys.clear();
  for (const f of ALL_FIELDS.values()) {
    effective[f.key] = f.envVar ? (process.env[f.envVar] ?? "") : "";
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const rows = await prisma.platformSetting.findMany();
      for (const r of rows) {
        try {
          const value = r.isSecret ? decryptSecret(r.value) : r.value;
          effective[r.key] = value;
          if (value.trim().length > 0) dbKeys.add(r.key);
        } catch {
          /* skip undecryptable rows */
        }
      }
      await loadBrandSettings();
      return; // loaded successfully
    } catch {
      // DB not reachable yet (cold start) — wait and retry; env defaults stand
      // if every attempt fails (a later save/load will refresh the cache).
      if (attempt < 5) await new Promise((r) => setTimeout(r, 2500));
    }
  }
}

/* --------------------- Per-brand setting overrides ----------------------- *
 *  A white-label brand can bring its OWN sending identity — its SMTP relay, its
 *  Twilio sender, its WhatsApp number — so mail and messages a tenant's
 *  customers receive come from the tenant, not from the platform. Overrides use
 *  the SAME key namespace as the platform settings above, so a brand only
 *  stores what it actually white-labels and anything it leaves blank keeps
 *  falling through to the platform value.
 *
 *  Held in the same style of in-memory cache as the platform settings (loaded
 *  at boot, refreshed on save) so every read stays synchronous — services deep
 *  in a call path can resolve a brand's sender without becoming async.
 * ------------------------------------------------------------------------- */
const brandEffective = new Map<string, Record<string, string>>();

/** (Re)load every brand's setting overrides into the cache. */
export async function loadBrandSettings(): Promise<void> {
  try {
    const rows = await prisma.brandSetting.findMany();
    brandEffective.clear();
    for (const r of rows) {
      let value: string;
      try {
        value = r.isSecret ? decryptSecret(r.value) : r.value;
      } catch {
        continue; // skip undecryptable rows
      }
      if (!value.trim()) continue; // blank = "use the platform value"
      const bucket = brandEffective.get(r.brandId) ?? {};
      bucket[r.key] = value;
      brandEffective.set(r.brandId, bucket);
    }
  } catch {
    // DB not reachable (cold start) — platform values stand until the next load.
  }
}

/**
 * Synchronous effective value.
 *
 * Resolution order: this brand's override → platform DB override → env
 * fallback. Passing no brand (or a brand with nothing set for the key) gives
 * exactly the platform behaviour that existed before brands, so every existing
 * call site keeps working unchanged.
 */
export function getEffective(key: string, brandId?: string | null): string {
  if (brandId) {
    const own = brandEffective.get(brandId)?.[key];
    if (own && own.trim()) return own;
  }
  return effective[key] ?? "";
}

/** Raw per-brand override (no platform fallback) — used by the admin view to
 *  show whether THIS brand has its own value or is inheriting the platform's. */
export function getBrandOverride(brandId: string, key: string): string {
  return brandEffective.get(brandId)?.[key] ?? "";
}

/* --------------------- Global master-prompt template --------------------- *
 *  Admin-editable scaffold wrapped around every assistant's compiled prompt.
 *  Stored as a plain (non-field) platform setting; empty string means "use the
 *  built-in DEFAULT_PROMPT_TEMPLATE". Reads are synchronous off the cache so the
 *  prompt compiler stays a pure, sync function. */
const PROMPT_TEMPLATE_KEY = "prompt.masterTemplate";
const PROMPT_TEMPLATE_HISTORY_KEY = "prompt.masterTemplateHistory";
/** How many replaced template versions we keep for the admin to revert to. */
const PROMPT_TEMPLATE_HISTORY_MAX = 10;

export interface PromptTemplateVersion {
  /** The template text that was replaced ("" = the built-in default was in use). */
  template: string;
  /** When it was replaced (i.e. when the save/reset that removed it happened). */
  replacedAt: string;
  /** Who made the change that replaced it. */
  replacedBy: string;
}

/** The saved override template, or "" when none is set (→ compiler uses its default). */
export function getPromptTemplate(): string {
  return getEffective(PROMPT_TEMPLATE_KEY);
}

/** The template customers SEE (AI Brain preview / stored master prompt):
 *  the admin's custom override, else the full built-in default. */
export function getDisplayPromptTemplate(): string {
  return getPromptTemplate().trim() || DEFAULT_PROMPT_TEMPLATE;
}

/** The template live-call prompts are compiled with on the wire (Vapi/WhatsApp):
 *  always the compact token-efficient scaffold. Customers never see this — the
 *  per-customer sections (identity, services, FAQs, rules) are still included. */
export function getVapiPromptTemplate(): string {
  return DEFAULT_PROMPT_TEMPLATE_SHORT;
}

/** Previously saved template versions, newest first — the admin's undo trail
 *  for accidental "Load default" / "Reset to default" saves. */
export function getPromptTemplateHistory(): PromptTemplateVersion[] {
  try {
    const raw = getEffective(PROMPT_TEMPLATE_HISTORY_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? (arr as PromptTemplateVersion[]) : [];
  } catch {
    return [];
  }
}

/** Save (or, with an empty string, reset) the master-prompt template, then
 *  refresh the in-memory cache so live compiles pick it up immediately.
 *  The version being replaced is pushed onto the history trail first. */
export async function setPromptTemplate(value: string, savedBy = ""): Promise<void> {
  const v = (value ?? "").trim();
  const prev = getPromptTemplate().trim();
  if (prev !== v) {
    const history = [
      { template: prev, replacedAt: new Date().toISOString(), replacedBy: savedBy },
      ...getPromptTemplateHistory(),
    ].slice(0, PROMPT_TEMPLATE_HISTORY_MAX);
    await prisma.platformSetting.upsert({
      where: { key: PROMPT_TEMPLATE_HISTORY_KEY },
      update: { value: JSON.stringify(history), isSecret: false },
      create: { key: PROMPT_TEMPLATE_HISTORY_KEY, value: JSON.stringify(history), isSecret: false },
    });
  }
  await prisma.platformSetting.upsert({
    where: { key: PROMPT_TEMPLATE_KEY },
    update: { value: v, isSecret: false },
    create: { key: PROMPT_TEMPLATE_KEY, value: v, isSecret: false },
  });
  await loadSettings();
}

/* --------------------- Per-country regional styles ----------------------- *
 *  Admin-editable per-country persona blocks appended to the live assistant's
 *  prompt so it sounds local to the caller's country. Stored as a JSON map
 *  { ISO: text } of OVERRIDES only; a country absent from the map uses the
 *  built-in default (lib/countryStyles.ts). An empty-string entry deliberately
 *  disables that country's block. Reads are synchronous off the cache. */
const COUNTRY_STYLES_KEY = "prompt.countryStyles";

/** The admin's raw override map (ISO → text), keys normalised to uppercase.
 *  Empty when unset or unparseable. */
export function getCountryStyleOverrides(): Record<string, string> {
  try {
    const raw = getEffective(COUNTRY_STYLES_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(parsed as Record<string, unknown>)) {
      const code = normalizeCountry(k);
      if (code && typeof val === "string") out[code] = val;
    }
    return out;
  } catch {
    return {};
  }
}

/** The effective style map (built-in defaults with admin overrides applied) —
 *  what the admin UI shows so every country is editable in one place. */
export function getEffectiveCountryStyles(): Record<string, string> {
  return { ...BUILTIN_COUNTRY_STYLES, ...getCountryStyleOverrides() };
}

/** Resolve the effective regional style text for one country: the admin
 *  override wins (including a deliberate empty string), else the built-in,
 *  else "" (→ no regional block appended). */
export function getCountryStyle(iso: string): string {
  const code = normalizeCountry(iso);
  if (!code) return "";
  const overrides = getCountryStyleOverrides();
  if (Object.prototype.hasOwnProperty.call(overrides, code)) return overrides[code];
  return BUILTIN_COUNTRY_STYLES[code] ?? "";
}

/** Save the per-country override map, then refresh the cache. Only entries that
 *  differ from the built-in default are kept, so the stored map stays minimal
 *  and future default changes still flow through for untouched countries. */
export async function setCountryStyles(map: Record<string, string>, _savedBy = ""): Promise<void> {
  const overrides: Record<string, string> = {};
  for (const [k, val] of Object.entries(map ?? {})) {
    const code = normalizeCountry(k);
    if (!code || typeof val !== "string") continue;
    const text = val.trim();
    // Keep an override only when it actually changes the built-in (including a
    // blank that disables a built-in country).
    if (text !== (BUILTIN_COUNTRY_STYLES[code] ?? "").trim()) overrides[code] = text;
  }
  const value = Object.keys(overrides).length ? JSON.stringify(overrides) : "";
  await prisma.platformSetting.upsert({
    where: { key: COUNTRY_STYLES_KEY },
    update: { value, isSecret: false },
    create: { key: COUNTRY_STYLES_KEY, value, isSecret: false },
  });
  await loadSettings();
}

/* ----------------------------- Industry list ----------------------------- *
 *  The AI Brain "Industry / Niche" options = the built-in taxonomy plus any
 *  admin-approved custom entries. A customer can propose a new industry when
 *  none fits; proposals wait in a pending queue until an admin approves (then it
 *  joins the public list everyone sees) or rejects it. Both lists live as JSON
 *  arrays in platform settings; reads are synchronous off the settings cache. */
const INDUSTRIES_APPROVED_KEY = "industries.approved";
const INDUSTRIES_PENDING_KEY = "industries.pending";
/** Safety cap so the queue can't grow unbounded from spam submissions. */
const INDUSTRIES_PENDING_MAX = 300;

export interface PendingIndustry {
  value: string;
  byEmail: string;
  byUserId: string;
  at: string; // ISO timestamp of submission
}

function readApprovedIndustries(): string[] {
  try {
    const raw = getEffective(INDUSTRIES_APPROVED_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function readPendingIndustries(): PendingIndustry[] {
  try {
    const raw = getEffective(INDUSTRIES_PENDING_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is PendingIndustry =>
        !!p && typeof p === "object" && typeof (p as PendingIndustry).value === "string",
    );
  } catch {
    return [];
  }
}

async function writePlatformJson(key: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value);
  await prisma.platformSetting.upsert({
    where: { key },
    update: { value: serialized, isSecret: false },
    create: { key, value: serialized, isSecret: false },
  });
  await loadSettings();
}

/** Public industry list = built-ins + approved customs (deduped, built-ins first). */
export function getPublicIndustries(): string[] {
  const out = [...BUILTIN_INDUSTRIES];
  for (const v of readApprovedIndustries()) if (!industryInList(v, out)) out.push(v);
  return out;
}

/** Admin view: the approved custom entries + the pending-review queue. */
export function getIndustryAdminView(): { approved: string[]; pending: PendingIndustry[] } {
  return { approved: readApprovedIndustries(), pending: readPendingIndustries() };
}

export type IndustrySuggestOutcome = "submitted" | "exists" | "pending";

/** A customer proposes a custom industry (already sanitized by the caller).
 *  - "exists":  already a built-in / approved option → nothing to do
 *  - "pending": already awaiting review → deduped, nothing added
 *  - "submitted": queued for admin review */
export async function suggestIndustry(
  cleaned: string,
  user: { id: string; email: string },
): Promise<IndustrySuggestOutcome> {
  if (industryInList(cleaned, getPublicIndustries())) return "exists";
  const pending = readPendingIndustries();
  if (pending.some((p) => p.value.toLowerCase() === cleaned.toLowerCase())) return "pending";
  const next = [
    ...pending,
    { value: cleaned, byEmail: user.email, byUserId: user.id, at: new Date().toISOString() },
  ].slice(-INDUSTRIES_PENDING_MAX);
  await writePlatformJson(INDUSTRIES_PENDING_KEY, next);
  return "submitted";
}

/** Approve a pending industry → add to the approved list, drop it from the queue. */
export async function approveIndustry(value: string): Promise<void> {
  const clean = normalizeIndustryWhitespace(value);
  const pending = readPendingIndustries().filter(
    (p) => p.value.toLowerCase() !== clean.toLowerCase(),
  );
  const approved = readApprovedIndustries();
  if (clean && !industryInList(clean, [...BUILTIN_INDUSTRIES, ...approved])) approved.push(clean);
  await writePlatformJson(INDUSTRIES_APPROVED_KEY, approved);
  await writePlatformJson(INDUSTRIES_PENDING_KEY, pending);
}

/** Reject (drop) a pending industry without adding it to the list. */
export async function rejectIndustry(value: string): Promise<void> {
  const clean = value.toLowerCase();
  const pending = readPendingIndustries().filter((p) => p.value.toLowerCase() !== clean);
  await writePlatformJson(INDUSTRIES_PENDING_KEY, pending);
}

/** Remove a previously-approved custom industry (built-ins can't be removed). */
export async function removeApprovedIndustry(value: string): Promise<void> {
  const clean = value.toLowerCase();
  const approved = readApprovedIndustries().filter((v) => v.toLowerCase() !== clean);
  await writePlatformJson(INDUSTRIES_APPROVED_KEY, approved);
}

/* -------------- Gender-matched default assistant names ------------------- *
 *  At onboarding, an assistant whose name is still the default is renamed to
 *  match its picked voice's gender — a male voice → the "male" name, a female
 *  voice → the "female" name. Both are admin-editable; blank falls back to the
 *  built-in defaults below. */
const AGENT_NAME_MALE_KEY = "agent.defaultNameMale";
const AGENT_NAME_FEMALE_KEY = "agent.defaultNameFemale";
export const DEFAULT_AGENT_NAME_MALE = "Mark";
export const DEFAULT_AGENT_NAME_FEMALE = "Jessica";

/** Effective default assistant names (admin override → built-in default). */
export function getAgentDefaultNames(): { male: string; female: string } {
  return {
    male: getEffective(AGENT_NAME_MALE_KEY).trim() || DEFAULT_AGENT_NAME_MALE,
    female: getEffective(AGENT_NAME_FEMALE_KEY).trim() || DEFAULT_AGENT_NAME_FEMALE,
  };
}

/** Save the default assistant names (blank → revert that slot to its default),
 *  then refresh the cache. */
export async function setAgentDefaultNames(male: string, female: string): Promise<void> {
  const entries: [string, string][] = [
    [AGENT_NAME_MALE_KEY, (male ?? "").trim()],
    [AGENT_NAME_FEMALE_KEY, (female ?? "").trim()],
  ];
  for (const [key, value] of entries) {
    await prisma.platformSetting.upsert({
      where: { key },
      update: { value, isSecret: false },
      create: { key, value, isSecret: false },
    });
  }
  await loadSettings();
}

/* --------------------- Global default agent LLM model -------------------- *
 *  The provider + model every provisioned Vapi assistant is created/synced with.
 *  Stored as two plain platform settings; read synchronously off the cache so
 *  the assistant-payload builder stays a pure, sync function. Falls back to the
 *  built-in default (Claude Haiku 4.5) when unset, or if a previously-saved value
 *  is no longer in the catalogue (e.g. an option was removed). */
const AGENT_LLM_PROVIDER_KEY = "agent.llmProvider";
const AGENT_LLM_MODEL_KEY = "agent.llmModel";

/** Effective default LLM for new/synced assistants (admin override → built-in).
 *  Returns whatever the admin saved (the PUT route validates it against Vapi's
 *  live catalogue at save time), falling back to the built-in default when unset.
 *  Kept synchronous so the assistant-payload builder stays a pure, sync function. */
export function getAgentLlm(): { provider: string; model: string } {
  const provider = getEffective(AGENT_LLM_PROVIDER_KEY).trim();
  const model = getEffective(AGENT_LLM_MODEL_KEY).trim();
  if (provider && model) return { provider, model };
  return { ...DEFAULT_AGENT_LLM };
}

/** Save the default agent LLM (provider + model), then refresh the cache so live
 *  provisions pick it up immediately. Caller validates against the catalogue. */
export async function setAgentLlm(provider: string, model: string): Promise<void> {
  const entries: [string, string][] = [
    [AGENT_LLM_PROVIDER_KEY, provider.trim()],
    [AGENT_LLM_MODEL_KEY, model.trim()],
  ];
  for (const [key, value] of entries) {
    await prisma.platformSetting.upsert({
      where: { key },
      update: { value, isSecret: false },
      create: { key, value, isSecret: false },
    });
  }
  await loadSettings();
}

/* ----------------------- Transcriber (STT) fallback ---------------------- *
 *  The PRIMARY transcriber stays auto-chosen by language. These settings add
 *  the admin's fallback: an optional preferred provider/model (tried first) and
 *  an "auto fallback" toggle (we then also auto-pick a capable backup). Applied
 *  to every assistant's transcriber.fallbackPlan on create/sync. */
const TRANSCRIBER_AUTO_FALLBACK_KEY = "transcriber.autoFallback";
const TRANSCRIBER_FALLBACK_PROVIDER_KEY = "transcriber.fallbackProvider";
const TRANSCRIBER_FALLBACK_MODEL_KEY = "transcriber.fallbackModel";

/** Effective transcriber-fallback preference (defaults: off, no preferred). Kept
 *  synchronous so the assistant-payload builder stays a pure, sync function. */
export function getTranscriberFallback(): { autoFallback: boolean; provider: string; model: string } {
  return {
    autoFallback: getEffective(TRANSCRIBER_AUTO_FALLBACK_KEY).trim() === "true",
    provider: getEffective(TRANSCRIBER_FALLBACK_PROVIDER_KEY).trim(),
    model: getEffective(TRANSCRIBER_FALLBACK_MODEL_KEY).trim(),
  };
}

/** Save the transcriber-fallback preference, then refresh the cache so live
 *  provisions pick it up immediately. Caller validates provider/model. */
export async function setTranscriberFallback(input: {
  autoFallback: boolean;
  provider: string;
  model: string;
}): Promise<void> {
  const entries: [string, string][] = [
    [TRANSCRIBER_AUTO_FALLBACK_KEY, input.autoFallback ? "true" : "false"],
    [TRANSCRIBER_FALLBACK_PROVIDER_KEY, input.provider.trim()],
    [TRANSCRIBER_FALLBACK_MODEL_KEY, input.model.trim()],
  ];
  for (const [key, value] of entries) {
    await prisma.platformSetting.upsert({
      where: { key },
      update: { value, isSecret: false },
      create: { key, value, isSecret: false },
    });
  }
  await loadSettings();
}

/* --------------------------- Onboarding: card wall ------------------------ *
 *  Whether a NEW signup must put a card on file before the dashboard opens.
 *
 *  Read ONCE per signup (auth.routes.ts) and snapshotted onto the Profile row as
 *  `cardRequiredAtSignup` — never consulted at runtime by any gate. That is what
 *  makes the policy non-retroactive: flipping this toggle changes what the NEXT
 *  signup gets and nothing else, so a customer already using the app can never be
 *  walled off by an admin click.
 *
 *  Deliberately async and reading the row directly rather than going through the
 *  sync `getEffective` cache: that cache only refreshes at boot and after a local
 *  save, so on a multi-instance deploy a flip on one instance would keep stamping
 *  the stale value on the others until restart. The signup handler is already
 *  async and DB-bound, so the extra read costs nothing that matters. */
export const ONBOARDING_CARD_REQUIRED_KEY = "onboarding.cardRequired";

/** True when new signups must add a card before they get dashboard access.
 *  Absent row (never saved) or any non-"true" value ⇒ OFF, the card-less default. */
export async function getOnboardingCardRequired(
  brandId: string | null | undefined = currentBrandId(),
): Promise<boolean> {
  // A white-label brand may set its own policy for its sign-ups; the platform
  // setting is the fallback. Resolved through a dynamic import because
  // brands.ts imports this module — a static import back would be a cycle for
  // the sake of one lookup.
  if (brandId) {
    const { cachedBrand } = await import("./brands.js");
    const own = brandCardRequired(cachedBrand(brandId));
    if (own !== null) return own;
  }
  const row = await prisma.platformSetting.findUnique({
    where: { key: ONBOARDING_CARD_REQUIRED_KEY },
  });
  // Compare the literal — Boolean(getEffective(k)) would read "false" as true.
  return row?.value.trim() === "true";
}

/** Save the card-required policy for FUTURE signups, then refresh the cache so
 *  anything reading it synchronously stays coherent. Existing accounts are
 *  untouched by design — their snapshot already decided their treatment. */
export async function setOnboardingCardRequired(enabled: boolean): Promise<void> {
  const value = enabled ? "true" : "false";
  await prisma.platformSetting.upsert({
    where: { key: ONBOARDING_CARD_REQUIRED_KEY },
    update: { value, isSecret: false },
    create: { key: ONBOARDING_CARD_REQUIRED_KEY, value, isSecret: false },
  });
  await loadSettings();
}

/** Effective configuration (DB or env) — gates whether the feature works. */
function isConfigured(integ: IntegrationDef, brandId?: string | null): boolean {
  return integ.required.every((k) => getEffective(k, brandId).trim().length > 0);
}

/**
 * Is this integration usable for the given tenant?
 *
 * The brand-aware form of `integrationsStatus()[id]`, and the one every SENDER
 * must gate on. A white-label brand can bring its own SMTP relay or Twilio
 * account while the platform has none configured at all — checking only the
 * platform would refuse to send for a brand that is, in fact, fully set up.
 * With no brand it answers exactly as before.
 */
export function integrationConfiguredFor(id: string, brandId?: string | null): boolean {
  const integ = INTEGRATIONS.find((i) => i.id === id);
  return integ ? isConfigured(integ, brandId) : false;
}

/** Configured by an admin in the DB (ignores env fallback) — drives the "Connected" badge. */
function isConfiguredViaDb(integ: IntegrationDef): boolean {
  return integ.required.every((k) => dbKeys.has(k) && getEffective(k).trim().length > 0);
}

/** Flags consumed by /health and feature gating. */
export function integrationsStatus(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const i of INTEGRATIONS) out[i.id] = isConfigured(i);
  return out;
}

function mask(v: string): string {
  if (!v) return "";
  return v.length <= 4 ? "••••" : `••••••••${v.slice(-4)}`;
}

/** Admin-facing view — secrets masked, never raw. */
export function integrationsView() {
  return INTEGRATIONS.map((i) => ({
    id: i.id,
    name: i.name,
    description: i.description,
    // "Connected" = the admin saved the required keys here (in the DB).
    // Anything only present via .env fallback shows as "Not connected".
    connected: isConfiguredViaDb(i),
    fields: i.fields.map((f) => {
      const v = getEffective(f.key);
      return {
        key: f.key,
        label: f.label,
        secret: f.secret,
        isSet: v.trim().length > 0,
        // Every field is masked (last 4 shown) — never return a raw value.
        value: mask(v),
      };
    }),
  }));
}

/**
 * Save submitted field values. An empty or mask-looking value means "unchanged"
 * and is skipped (all fields are masked now). Refreshes the cache afterwards.
 */
export async function saveIntegrations(updates: Record<string, string>): Promise<void> {
  for (const [key, raw] of Object.entries(updates)) {
    const f = ALL_FIELDS.get(key);
    if (!f) continue;
    const val = typeof raw === "string" ? raw : "";
    if (val === "" || val.startsWith("•")) continue; // unchanged
    const stored = f.secret ? encryptSecret(val) : val;
    await prisma.platformSetting.upsert({
      where: { key },
      update: { value: stored, isSecret: f.secret },
      create: { key, value: stored, isSecret: f.secret },
    });
  }
  await loadSettings();
}

/** Set a single known setting value (encrypting if the field is secret) and
 *  refresh the cache. Used for granular toggles like the SMS sender number. */
export async function setSettingValue(key: string, value: string): Promise<void> {
  const f = ALL_FIELDS.get(key);
  if (!f) return;
  const stored = f.secret ? encryptSecret(value) : value;
  await prisma.platformSetting.upsert({
    where: { key },
    update: { value: stored, isSecret: f.secret },
    create: { key, value: stored, isSecret: f.secret },
  });
  await loadSettings();
}

/* ------------------------------ Voice provider ---------------------------- *
 *  Both TTS providers (Deepgram + ElevenLabs) run side-by-side via Vapi — there is
 *  no global toggle. The provider for any voice is decided by the voice id itself
 *  (see providerForVoiceId in services/voices.ts). This type is the shared union.
 * -------------------------------------------------------------------------- */
export type VoiceProvider = "deepgram" | "elevenlabs";

/** Remove an integration's stored values from the DB, reverting to env fallback. */
export async function clearIntegration(integrationId: string): Promise<void> {
  const integ = INTEGRATIONS.find((i) => i.id === integrationId);
  if (!integ) return;
  await prisma.platformSetting.deleteMany({
    where: { key: { in: integ.fields.map((f) => f.key) } },
  });
  await loadSettings();
}

/* -------------------- Brand-level messaging integrations ------------------ *
 *  Which integrations a brand may white-label. Deliberately NOT every one:
 *  Vapi, OpenAI, Deepgram/ElevenLabs and the CRM are platform infrastructure
 *  billed to the platform and are configured once by the SUPER_ADMIN. What a
 *  brand overrides is the part its customers actually SEE — the address mail
 *  arrives from, the number texts come from, the WhatsApp sender.
 * ------------------------------------------------------------------------- */
export const BRAND_INTEGRATION_IDS = ["email", "twilio", "whatsapp"] as const;
export type BrandIntegrationId = (typeof BRAND_INTEGRATION_IDS)[number];

export const BRAND_INTEGRATIONS: IntegrationDef[] = INTEGRATIONS.filter((i) =>
  (BRAND_INTEGRATION_IDS as readonly string[]).includes(i.id),
);

const BRAND_FIELDS = new Map<string, FieldDef>();
for (const i of BRAND_INTEGRATIONS) for (const f of i.fields) BRAND_FIELDS.set(f.key, f);

/** True when the key is one a brand is allowed to override. */
export function isBrandOverridableKey(key: string): boolean {
  return BRAND_FIELDS.has(key);
}

/**
 * Admin-facing view of ONE brand's messaging overrides. Every field reports
 * both what the brand set (masked, never raw) and whether it is currently
 * inheriting the platform value — so the operator can see at a glance which
 * channels are genuinely white-labelled and which still send as the platform.
 */
export function brandIntegrationsView(brandId: string) {
  return BRAND_INTEGRATIONS.map((i) => {
    const fields = i.fields.map((f) => {
      const own = getBrandOverride(brandId, f.key);
      return {
        key: f.key,
        label: f.label,
        secret: f.secret,
        placeholder: f.placeholder ?? "",
        /** This brand set its own value. */
        isSet: own.trim().length > 0,
        /** Blank here → the platform's value is used instead. */
        inherited: own.trim().length === 0,
        value: mask(own),
      };
    });
    return {
      id: i.id,
      name: i.name,
      description: i.description,
      /** The brand overrides every key this integration needs to stand alone. */
      overridden: i.required.every((k) => getBrandOverride(brandId, k).trim().length > 0),
      fields,
    };
  });
}

/**
 * Save a brand's overrides. Same masked-field contract as the platform form: an
 * empty or mask-looking value means "unchanged" and is skipped. To hand a key
 * back to the platform, pass the sentinel "__inherit__" — that deletes the row
 * rather than storing a blank that would read as a deliberately empty sender.
 */
export const INHERIT_SENTINEL = "__inherit__";

export async function saveBrandIntegrations(
  brandId: string,
  updates: Record<string, string>,
): Promise<void> {
  for (const [key, raw] of Object.entries(updates)) {
    const f = BRAND_FIELDS.get(key);
    if (!f) continue; // not brand-overridable — ignore silently
    const val = typeof raw === "string" ? raw : "";
    if (val === INHERIT_SENTINEL) {
      await prisma.brandSetting.deleteMany({ where: { brandId, key } });
      continue;
    }
    if (val === "" || val.startsWith("•")) continue; // unchanged
    const stored = f.secret ? encryptSecret(val) : val;
    await prisma.brandSetting.upsert({
      where: { brandId_key: { brandId, key } },
      update: { value: stored, isSecret: f.secret },
      create: { brandId, key, value: stored, isSecret: f.secret },
    });
  }
  await loadBrandSettings();
}

/** Drop one integration's overrides for a brand — it goes back to sending as the platform. */
export async function clearBrandIntegration(brandId: string, integrationId: string): Promise<void> {
  const integ = BRAND_INTEGRATIONS.find((i) => i.id === integrationId);
  if (!integ) return;
  await prisma.brandSetting.deleteMany({
    where: { brandId, key: { in: integ.fields.map((f) => f.key) } },
  });
  await loadBrandSettings();
}
