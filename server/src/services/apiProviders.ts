/* ------------------------------------------------------------------ *
 *  Provider registry — the one place that knows what a third-party API
 *  *is*, as opposed to how it has behaved (services/apiCenter.ts) or
 *  whether we hold its keys (services/settings.ts).
 *
 *  Adding a provider to the API Center is a matter of adding a row here:
 *  the grid, the category groups, the cost model, the status poller, the
 *  quota maths and the drawer are all driven off this table. No screen
 *  needs to change to support the next dozen vendors.
 *
 *  Deliberately static and dependency-free so it can be imported from a
 *  route, a service or a script without pulling in Prisma.
 * ------------------------------------------------------------------ */

export type ApiCategory =
  | "ai"
  | "voice"
  | "communication"
  | "calendar"
  | "crm"
  | "payments"
  | "email"
  | "storage"
  | "automation"
  | "monitoring"
  | "data";

export const CATEGORY_LABEL: Record<ApiCategory, string> = {
  ai: "AI & LLM",
  voice: "Voice & Speech",
  communication: "Communication",
  calendar: "Calendar",
  crm: "CRM",
  payments: "Payments",
  email: "Email",
  storage: "Cloud & Storage",
  automation: "Automation",
  monitoring: "Monitoring",
  data: "Data & Search",
};

/** Order categories appear in on the grid — busiest/most critical first. */
export const CATEGORY_ORDER: ApiCategory[] = [
  "voice",
  "ai",
  "communication",
  "payments",
  "crm",
  "calendar",
  "email",
  "data",
  "automation",
  "storage",
  "monitoring",
];

export type AuthMethod =
  | "api_key"
  | "bearer"
  | "oauth2"
  | "basic"
  | "hmac"
  | "smtp"
  | "none";

export const AUTH_LABEL: Record<AuthMethod, string> = {
  api_key: "API key",
  bearer: "Bearer token",
  oauth2: "OAuth 2.0",
  basic: "HTTP Basic",
  hmac: "HMAC signature",
  smtp: "SMTP credentials",
  none: "Unauthenticated",
};

/**
 * What one billable unit is for this vendor. Cost is always
 * `units × unitCostUsd`; for `request` providers `units` is simply the call
 * count, which is why a flat per-call price is a usable estimate there and a
 * poor one for token- or minute-priced vendors (see {@link ProviderDef.costConfidence}).
 */
export type BillingUnit =
  | "request"
  | "1k_tokens"
  | "1k_chars"
  | "minute"
  | "message"
  | "segment"
  | "gb"
  | "none";

export const UNIT_LABEL: Record<BillingUnit, string> = {
  request: "per request",
  "1k_tokens": "per 1K tokens",
  "1k_chars": "per 1K characters",
  minute: "per minute",
  message: "per message",
  segment: "per SMS segment",
  gb: "per GB",
  none: "not metered",
};

/**
 * How much to trust the cost figure this provider produces.
 *  - `metered`   — the tracer records real billable units (tokens, characters,
 *                  seconds), so cost is arithmetic, not guesswork.
 *  - `estimated` — cost is `calls × list price`. Right order of magnitude for
 *                  flat-rate endpoints, wrong for anything usage-priced.
 *  - `none`      — no price is known; the UI shows "—", never a zero that reads
 *                  as "this is free".
 */
export type CostConfidence = "metered" | "estimated" | "none";

/** Response headers a vendor uses to advertise rate-limit headroom, when it does. */
export interface RateLimitHeaders {
  limit: string;
  remaining: string;
  /** Either a unix timestamp, an ISO date, or seconds-until-reset. */
  reset: string;
}

export interface ProviderDef {
  /** Trace key — must match the `provider` written to api_request_logs. */
  id: string;
  name: string;
  category: ApiCategory;
  blurb: string;
  /** Id in services/settings.ts INTEGRATIONS, when the keys live there. */
  integrationId?: string;
  /**
   * Whether this platform actually routes traffic through the vendor today.
   * Unwired rows still render (greyed, "Not configured") so the roadmap is
   * visible and so adding the integration later needs no UI work.
   */
  wired: boolean;
  authMethod: AuthMethod;
  docsUrl: string;
  dashboardUrl?: string;
  /**
   * statuspage.io v2 summary endpoint. Polled by services/providerStatus.ts;
   * a vendor without one (or whose endpoint moves) reports "unknown" rather
   * than a fabricated "operational".
   */
  statusApiUrl?: string;
  statusPageUrl?: string;
  /** Vendor API version this codebase pins/targets, when it pins one. */
  apiVersion?: string;
  unit: BillingUnit;
  /**
   * Published list price at the time of writing, in USD, used only as the
   * seed for the admin-editable value in api_provider_settings. Treated
   * throughout the UI as an estimate to confirm, never as billing truth.
   */
  defaultUnitCostUsd?: number;
  costConfidence: CostConfidence;
  rateLimitHeaders?: RateLimitHeaders;
  /** Only meaningful for vendors we sign inbound webhooks with. */
  webhooks?: "inbound" | "outbound" | "both";
}

/** The standard statuspage.io header trio, used by most modern API vendors. */
const STD_RL: RateLimitHeaders = {
  limit: "x-ratelimit-limit",
  remaining: "x-ratelimit-remaining",
  reset: "x-ratelimit-reset",
};

export const PROVIDER_DEFS: ProviderDef[] = [
  /* ------------------------------- Voice ------------------------------ */
  {
    id: "vapi",
    name: "Vapi",
    category: "voice",
    blurb: "Voice AI orchestration — assistants, calls and telephony routing",
    integrationId: "vapi",
    wired: true,
    authMethod: "bearer",
    docsUrl: "https://docs.vapi.ai",
    dashboardUrl: "https://dashboard.vapi.ai",
    statusApiUrl: "https://status.vapi.ai/api/v2/summary.json",
    statusPageUrl: "https://status.vapi.ai",
    unit: "minute",
    defaultUnitCostUsd: 0.05,
    costConfidence: "estimated",
    rateLimitHeaders: STD_RL,
    webhooks: "inbound",
  },
  {
    id: "deepgram",
    name: "Deepgram",
    category: "voice",
    blurb: "Speech-to-text and TTS voice samples",
    integrationId: "deepgram",
    wired: true,
    authMethod: "api_key",
    docsUrl: "https://developers.deepgram.com/docs",
    dashboardUrl: "https://console.deepgram.com",
    statusApiUrl: "https://status.deepgram.com/api/v2/summary.json",
    statusPageUrl: "https://status.deepgram.com",
    unit: "1k_chars",
    defaultUnitCostUsd: 0.015,
    costConfidence: "estimated",
    webhooks: "outbound",
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    category: "voice",
    blurb: "Neural TTS — the fallback voice provider",
    integrationId: "elevenlabs",
    wired: true,
    authMethod: "api_key",
    docsUrl: "https://elevenlabs.io/docs",
    dashboardUrl: "https://elevenlabs.io/app",
    statusApiUrl: "https://status.elevenlabs.io/api/v2/summary.json",
    statusPageUrl: "https://status.elevenlabs.io",
    unit: "1k_chars",
    defaultUnitCostUsd: 0.18,
    costConfidence: "estimated",
    rateLimitHeaders: {
      limit: "x-ratelimit-limit",
      remaining: "x-ratelimit-remaining",
      reset: "x-ratelimit-reset-requests",
    },
  },
  {
    id: "assemblyai",
    name: "AssemblyAI",
    category: "voice",
    blurb: "Transcription and audio intelligence",
    wired: false,
    authMethod: "api_key",
    docsUrl: "https://www.assemblyai.com/docs",
    statusApiUrl: "https://status.assemblyai.com/api/v2/summary.json",
    statusPageUrl: "https://status.assemblyai.com",
    unit: "minute",
    costConfidence: "none",
  },

  /* --------------------------------- AI ------------------------------- */
  {
    id: "openai",
    name: "OpenAI",
    category: "ai",
    blurb: "LLM for the support assistant, summaries and onboarding extraction",
    integrationId: "openai",
    wired: true,
    authMethod: "bearer",
    docsUrl: "https://platform.openai.com/docs",
    dashboardUrl: "https://platform.openai.com/usage",
    statusApiUrl: "https://status.openai.com/api/v2/summary.json",
    statusPageUrl: "https://status.openai.com",
    unit: "1k_tokens",
    defaultUnitCostUsd: 0.01,
    costConfidence: "metered",
    rateLimitHeaders: {
      limit: "x-ratelimit-limit-requests",
      remaining: "x-ratelimit-remaining-requests",
      reset: "x-ratelimit-reset-requests",
    },
  },
  {
    id: "anthropic",
    name: "Anthropic",
    category: "ai",
    blurb: "Claude models — alternative LLM provider",
    wired: false,
    authMethod: "api_key",
    docsUrl: "https://docs.claude.com",
    dashboardUrl: "https://console.anthropic.com",
    statusApiUrl: "https://status.anthropic.com/api/v2/summary.json",
    statusPageUrl: "https://status.anthropic.com",
    apiVersion: "2023-06-01",
    unit: "1k_tokens",
    costConfidence: "none",
    rateLimitHeaders: {
      limit: "anthropic-ratelimit-requests-limit",
      remaining: "anthropic-ratelimit-requests-remaining",
      reset: "anthropic-ratelimit-requests-reset",
    },
  },

  /* ---------------------------- Communication ------------------------- */
  {
    id: "twilio",
    name: "Twilio",
    category: "communication",
    blurb: "SMS delivery and phone number provisioning",
    integrationId: "twilio",
    wired: true,
    authMethod: "basic",
    docsUrl: "https://www.twilio.com/docs",
    dashboardUrl: "https://console.twilio.com",
    statusApiUrl: "https://status.twilio.com/api/v2/summary.json",
    statusPageUrl: "https://status.twilio.com",
    apiVersion: "2010-04-01",
    unit: "segment",
    defaultUnitCostUsd: 0.0079,
    costConfidence: "estimated",
    webhooks: "both",
  },
  {
    id: "whatsapp",
    name: "WhatsApp Cloud API",
    category: "communication",
    blurb: "Meta Business messaging — call summaries and follow-ups",
    integrationId: "whatsapp",
    wired: true,
    authMethod: "bearer",
    docsUrl: "https://developers.facebook.com/docs/whatsapp/cloud-api",
    dashboardUrl: "https://business.facebook.com",
    statusPageUrl: "https://metastatus.com/whatsapp-business-api",
    apiVersion: "v21.0",
    unit: "message",
    defaultUnitCostUsd: 0.005,
    costConfidence: "estimated",
    webhooks: "both",
  },
  {
    id: "slack",
    name: "Slack",
    category: "communication",
    blurb: "Alert delivery to engineering channels",
    wired: false,
    authMethod: "bearer",
    docsUrl: "https://api.slack.com",
    statusApiUrl: "https://status.slack.com/api/v2.0.0/current",
    statusPageUrl: "https://status.slack.com",
    unit: "request",
    costConfidence: "none",
    webhooks: "outbound",
  },

  /* ------------------------------ Payments ---------------------------- */
  {
    id: "stripe",
    name: "Stripe",
    category: "payments",
    blurb: "Subscriptions, checkout and invoices",
    wired: true,
    authMethod: "bearer",
    docsUrl: "https://docs.stripe.com/api",
    dashboardUrl: "https://dashboard.stripe.com",
    statusPageUrl: "https://status.stripe.com",
    apiVersion: "2024-06-20",
    unit: "request",
    costConfidence: "none",
    rateLimitHeaders: STD_RL,
    webhooks: "inbound",
  },

  /* -------------------------------- CRM ------------------------------- */
  {
    id: "crm",
    name: "Nexleon CRM",
    category: "crm",
    blurb: "Central lead management — every call lead is pushed here",
    integrationId: "perfex",
    wired: true,
    authMethod: "api_key",
    docsUrl: "https://nexleon.com/docs",
    unit: "request",
    costConfidence: "none",
    webhooks: "outbound",
  },
  {
    id: "hubspot",
    name: "HubSpot",
    category: "crm",
    blurb: "Contact and deal sync",
    wired: false,
    authMethod: "oauth2",
    docsUrl: "https://developers.hubspot.com/docs/api/overview",
    statusApiUrl: "https://status.hubspot.com/api/v2/summary.json",
    statusPageUrl: "https://status.hubspot.com",
    unit: "request",
    costConfidence: "none",
  },

  /* ------------------------------ Calendar ---------------------------- */
  {
    id: "google",
    name: "Google Calendar",
    category: "calendar",
    blurb: "OAuth calendar booking and availability",
    integrationId: "google",
    wired: true,
    authMethod: "oauth2",
    docsUrl: "https://developers.google.com/calendar/api",
    dashboardUrl: "https://console.cloud.google.com/apis/dashboard",
    statusPageUrl: "https://www.google.com/appsstatus/dashboard/",
    apiVersion: "v3",
    unit: "request",
    costConfidence: "none",
  },
  {
    id: "outlook",
    name: "Outlook Calendar",
    category: "calendar",
    blurb: "Microsoft Graph calendar booking",
    wired: false,
    authMethod: "oauth2",
    docsUrl: "https://learn.microsoft.com/graph/api/resources/calendar",
    statusPageUrl: "https://portal.office.com/servicestatus",
    apiVersion: "v1.0",
    unit: "request",
    costConfidence: "none",
  },

  /* -------------------------------- Email ----------------------------- */
  {
    id: "smtp",
    name: "Email (SMTP)",
    category: "email",
    blurb: "Transactional email — works with any SMTP provider",
    integrationId: "email",
    wired: true,
    authMethod: "smtp",
    docsUrl: "https://nodemailer.com/smtp/",
    unit: "message",
    costConfidence: "none",
  },

  /* --------------------------- Data & Search -------------------------- */
  {
    id: "pinecone",
    name: "Pinecone",
    category: "data",
    blurb: "Vector search for knowledge-base retrieval",
    wired: false,
    authMethod: "api_key",
    docsUrl: "https://docs.pinecone.io",
    statusApiUrl: "https://status.pinecone.io/api/v2/summary.json",
    statusPageUrl: "https://status.pinecone.io",
    unit: "request",
    costConfidence: "none",
  },

  /* ----------------------------- Automation --------------------------- */
  {
    id: "zapier",
    name: "Zapier",
    category: "automation",
    blurb: "No-code workflow triggers",
    wired: false,
    authMethod: "api_key",
    docsUrl: "https://docs.zapier.com/platform",
    statusPageUrl: "https://status.zapier.com",
    unit: "request",
    costConfidence: "none",
    webhooks: "outbound",
  },
  {
    id: "make",
    name: "Make.com",
    category: "automation",
    blurb: "Scenario automation",
    wired: false,
    authMethod: "api_key",
    docsUrl: "https://www.make.com/en/api-documentation",
    statusPageUrl: "https://www.make.com/en/status",
    unit: "request",
    costConfidence: "none",
    webhooks: "outbound",
  },
  {
    id: "webhook",
    name: "Custom Webhooks",
    category: "automation",
    blurb: "Customer-configured outbound endpoints",
    wired: true,
    authMethod: "hmac",
    docsUrl: "/dashboard/admin/webhooks",
    unit: "request",
    costConfidence: "none",
    webhooks: "outbound",
  },

  /* --------------------------- Cloud & Storage ------------------------ */
  {
    id: "aws",
    name: "AWS",
    category: "storage",
    blurb: "Object storage and managed services",
    wired: false,
    authMethod: "hmac",
    docsUrl: "https://docs.aws.amazon.com",
    statusPageUrl: "https://health.aws.amazon.com/health/status",
    unit: "gb",
    costConfidence: "none",
  },
  {
    id: "azure",
    name: "Azure",
    category: "storage",
    blurb: "Managed services and Azure OpenAI",
    wired: false,
    authMethod: "oauth2",
    docsUrl: "https://learn.microsoft.com/azure",
    statusPageUrl: "https://azure.status.microsoft/status",
    unit: "gb",
    costConfidence: "none",
  },
  {
    id: "gcp",
    name: "Google Cloud",
    category: "storage",
    blurb: "Managed services and storage",
    wired: false,
    authMethod: "oauth2",
    docsUrl: "https://cloud.google.com/docs",
    statusPageUrl: "https://status.cloud.google.com",
    unit: "gb",
    costConfidence: "none",
  },

  /* ------------------------------ Internal ---------------------------- */
  {
    id: "self",
    name: "hello22 API",
    category: "monitoring",
    blurb: "The API this platform serves to its own apps",
    wired: true,
    authMethod: "bearer",
    docsUrl: "/dashboard/admin/api-center/logs",
    unit: "none",
    costConfidence: "none",
  },
];

const BY_ID = new Map(PROVIDER_DEFS.map((p) => [p.id, p]));

export function providerDef(id: string): ProviderDef | undefined {
  return BY_ID.get(id);
}

/**
 * A definition for any provider key, including ones that only ever show up in
 * the traffic log ("unknown", a vendor added to a tracer before this table).
 * Returning a synthesised row rather than `undefined` keeps every consumer —
 * grid, drawer, cost maths — free of null checks.
 */
export function providerDefOrFallback(id: string): ProviderDef {
  return (
    BY_ID.get(id) ?? {
      id,
      name: id.charAt(0).toUpperCase() + id.slice(1),
      category: "monitoring" as ApiCategory,
      blurb: "Seen in the traffic log but not in the provider registry",
      wired: true,
      authMethod: "none" as AuthMethod,
      docsUrl: "",
      unit: "request" as BillingUnit,
      costConfidence: "none" as CostConfidence,
    }
  );
}

/** Providers whose calls this server actually makes today. */
export function wiredProviders(): ProviderDef[] {
  return PROVIDER_DEFS.filter((p) => p.wired && p.id !== "self");
}

/** settings.ts integration id → trace provider key. */
export function providerForIntegration(integrationId: string): string | undefined {
  return PROVIDER_DEFS.find((p) => p.integrationId === integrationId)?.id;
}
