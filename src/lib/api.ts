import { env } from "@/lib/env";
import type { IndustriesListResponse, IndustrySuggestResponse } from "@shared/contracts/industries";
import type {
  AllVoicesResponse as SharedAllVoicesResponse,
  ProviderVoice as SharedProviderVoice,
  VoiceCatalogItem as SharedVoiceCatalogItem,
  VoiceCatalogResponse as SharedVoiceCatalogResponse,
} from "@shared/contracts/voices";
import type {
  Notification as SharedNotification,
  NotificationChannelsResponse,
  NotificationsListResponse,
  NotificationType as SharedNotificationType,
  TestSummaryResponse,
} from "@shared/contracts/notifications";
import type { OkResponse } from "@shared/contracts/common";
import type {
  AgentConfig,
  Appointment,
  BookingOverview,
  BookingSettings,
  CallIntent,
  CallLog,
  ChatMessage,
  CrmIntegration,
  EmailTemplate,
  EmailBranding,
  HumanTransferSettings,
  TransferDepartment,
  Profile,
  TranscriptTurn,
  TrialState,
  WebhookDelivery,
  WorkingHours,
} from "@/types";
import { activeBrandSlug, brandPath } from "@/lib/brandRoute";
import type {
  AdminTicketDepartment,
  AttachmentDescriptor,
  BrandTicketDepartmentInput,
  Ticket,
  TicketAgent,
  TicketLaneInfo,
  TicketListPage,
  TicketMessage,
  TicketPriority,
  TicketRatingsPage,
  TicketSavedReply,
  TicketStats,
  TicketStatus,
  TicketThread,
  TicketUploadPolicy,
  UpdatedTicket,
  TicketDepartment as RequesterTicketDepartment,
} from "@/types/ticket";
import type {
  AlertEvent,
  AlertMetric,
  AlertRule,
  AlertsResponse,
  ApiCenterRegistry,
  ApiCenterSnapshot,
  ApiKeyRow,
  ApiLogPage,
  ErrorGroup,
  ProviderDetail,
  ProviderSettingRow,
  ProviderStatusPayload,
  RangeKey,
} from "@/types/apiCenter";

// Typed API client for the Express backend (Bearer token + X-Brand header).

export const TOKEN_KEY = "hello22_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

// Whether the app believes it has a signed-in user (synced by the auth store). Lets a 401 force
// logout even when this tab's token was already cleared elsewhere, e.g. signed out in another tab.
let sessionActive = false;
export function markSessionActive(active: boolean) {
  sessionActive = active;
}

export class ApiError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  // For FormData bodies, let the browser set the multipart Content-Type (with boundary).
  const isFormData = typeof FormData !== "undefined" && init.body instanceof FormData;
  // With path routing every brand shares one host, so we have to name the brand. It selects a
  // public front door only; an authenticated request is re-scoped server-side to the account's tenant.
  const brandSlug = activeBrandSlug();
  const res = await fetch(`${env.apiUrl}${path}`, {
    ...init,
    headers: {
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(brandSlug ? { "X-Brand": brandSlug } : {}),
      ...(init.headers ?? {}),
    },
  });
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    const message = (isJson && (body as { error?: string }).error) || res.statusText;
    // 401 with a session = invalid token, force logout. Trips on token OR sessionActive so a tab
    // signed out elsewhere doesn't sit on the dashboard silently 401ing.
    if (res.status === 401 && (token || sessionActive)) forceLogout();
    throw new ApiError(res.status, message, isJson ? (body as { details?: unknown }).details : undefined);
  }
  return body as T;
}

/** Clear the token and bounce to login. Full page load, so the router basename doesn't apply and the brand
 *  prefix must be spelled out; the "already there" check compares the whole path or /acme/login redirects to itself. */
function forceLogout() {
  setToken(null);
  sessionActive = false;
  if (typeof window === "undefined") return;
  const login = brandPath("/login");
  if (window.location.pathname !== login) window.location.assign(login);
}

/** Multipart upload with progress. XHR because fetch still can't report upload progress; abortable so removing a file mid-upload stops it. */
export function uploadWithProgress<T>(
  path: string,
  file: File,
  opts: { onProgress?: (percent: number) => void; signal?: AbortSignal } = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append("file", file);

    xhr.open("POST", `${env.apiUrl}${path}`);
    const token = getToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    const brandSlug = activeBrandSlug();
    if (brandSlug) xhr.setRequestHeader("X-Brand", brandSlug);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      const isJson = xhr.getResponseHeader("content-type")?.includes("application/json");
      const body = isJson && xhr.responseText ? JSON.parse(xhr.responseText) : xhr.responseText;
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as T);
      } else {
        reject(
          new ApiError(xhr.status, (isJson && body?.error) || xhr.statusText || "Upload failed"),
        );
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "Upload failed — check your connection."));
    xhr.onabort = () => reject(new ApiError(0, "Upload cancelled"));

    opts.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}

/** Authenticated download → blob → a temporary <a download> click. Used by the
 *  ticket CSV export, which needs the Bearer token a plain link can't send. */
async function download(path: string, filename: string): Promise<void> {
  const token = getToken();
  const brandSlug = activeBrandSlug();
  const res = await fetch(`${env.apiUrl}${path}`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(brandSlug ? { "X-Brand": brandSlug } : {}),
    },
  });
  if (!res.ok) {
    if (res.status === 401 && (token || sessionActive)) forceLogout();
    const isJson = res.headers.get("content-type")?.includes("application/json");
    const message = isJson ? ((await res.json()) as { error?: string }).error : undefined;
    throw new ApiError(res.status, message || res.statusText);
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Serialise params into a query string, dropping empty and "all" values so the
 *  URL stays readable and the server sees its own defaults. */
function toQuery(params: Record<string, unknown>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    qs.set(key, String(value));
  }
  const q = qs.toString();
  return q ? `?${q}` : "";
}

const get = <T>(p: string) => request<T>(p);
const post = <T>(p: string, data?: unknown, init?: RequestInit) =>
  request<T>(p, {
    method: "POST",
    body: data === undefined ? undefined : JSON.stringify(data),
    ...init,
  });
/** Multipart upload — lets the browser set the Content-Type boundary itself. */
const upload = <T>(p: string, form: FormData) =>
  request<T>(p, { method: "POST", body: form });
const put = <T>(p: string, data: unknown) =>
  request<T>(p, { method: "PUT", body: JSON.stringify(data) });
const patch = <T>(p: string, data: unknown) =>
  request<T>(p, { method: "PATCH", body: JSON.stringify(data) });
const del = <T>(p: string, data?: unknown) =>
  request<T>(p, { method: "DELETE", body: data === undefined ? undefined : JSON.stringify(data) });

/** Filters shared by the API Center Logs table and its CSV export. */
export interface ApiLogFilters {
  provider?: string;
  status?: "all" | "success" | "error";
  environment?: string;
  search?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

/** Serialise log filters, dropping "all" and empty values so the URL stays readable. */
function apiLogQuery(params: ApiLogFilters): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "" || value === "all") continue;
    qs.set(key, String(value));
  }
  const q = qs.toString();
  return q ? `?${q}` : "";
}

/** SUPER_ADMIN = platform owner (every ADMIN right plus Brands, Platform Settings, API Center). Use lib/roles.ts helpers, don't compare by hand. */
export type UserRole = "USER" | "ADMIN" | "SUPER_ADMIN" | "STAFF" | "RESELLER";

/** One account the handler may raise a request for. */
export interface TicketRequesterOption {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  /** The tenant they belong to — what the platform owner is really choosing
   *  between on the brand lane; null for a platform-level account. */
  brand: { id: string; name: string } | null;
}

/** The handler inbox's filters, as the list and export endpoints take them. */
export interface AdminTicketListParams {
  status?: "all" | "unresolved" | "open" | "pending" | "resolved" | "closed";
  departmentId?: string;
  assigned?: "any" | "me" | "unassigned";
  /** A specific handler — narrows further than `assigned`. */
  assignedToId?: string;
  priority?: TicketPriority;
  /** Only tickets with a requester message the team hasn't read yet. */
  unread?: boolean;
  /** Narrow to one tenant. Only ever narrows: a handler tied to a brand cannot
   *  use it to reach another's (the server refuses). */
  brandId?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  permissions: string[];
  /** White-label tenant this account belongs to; null = platform-level. */
  brandId?: string | null;
  /** That tenant's display name, for the admin nav header. */
  brandName?: string | null;
  /** That tenant's address slug — which front door this account belongs on.
   *  See RequireBrandFrontDoor. */
  brandSlug?: string | null;
  /** Where that tenant's users sign in — its verified domain, else its platform
   *  subdomain. Used to leave a wrong brand HOST; null for platform accounts. */
  brandOrigin?: string | null;
  /** Assigned StaffRole's display name (e.g. "Support Agent"); null for admins,
   *  customers, resellers, or a staff member with no role assigned. */
  staffRoleName?: string | null;
  plan: "free" | "premium";
  profile: Profile | null;
}
interface AuthResponse {
  token: string;
  user: AuthUser;
}

export interface AnalyzeResult {
  businessName: string;
  description: string;
  phone: string;
  email: string;
  address: string;
  services: string[];
  faqs: { question: string; answer: string }[];
  /** AI-suggested, business-specific call-handling rules → seeded into Scenario Handling. */
  scenarios?: { ifText: string; thenText: string }[];
  /** Opening/trading hours, ONLY when stated on the site — else "" (client keeps its 9–5 default). */
  businessHours?: string;
}

/** One customer-proposed industry awaiting admin review. */
export interface PendingIndustry {
  value: string;
  byEmail: string;
  byUserId: string;
  at: string;
}

/** Admin view of the custom-industry system: approved entries + pending queue. */
export interface IndustryAdminView {
  approved: string[];
  pending: PendingIndustry[];
}

// Inferred from the shared Zod schemas in @shared/contracts/notifications; re-exported
// under the old names so nothing else has to change its imports.
export type NotificationType = SharedNotificationType;

/** Where typed digits must sit in a phone number — mirrors Twilio's "Match to".
 *  Keep in step with NumberMatch in server/src/services/sms.ts. */
export type NumberMatch = "start" | "anywhere" | "end";

export type ApiNotification = SharedNotification;

/** The visitor's IANA timezone (e.g. "Asia/Kolkata"), best-effort. Sent at signup
 *  so admin notifications can show times in the customer's own region. */
function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** Admin-managed custom scripts (SEO & tracking), injected on page load. */
export interface SeoScripts {
  head: string;
  body: string;
  footer: string;
}

/* ------------------------- White-label brands ---------------------------- */

/** One colour choice in the brand editor's palette picker. */
export interface BrandColorPreset {
  id: string;
  label: string;
  primary: string;
  accent: string;
  note: string;
}

/** One typeface, grouped as Business (sans) or Classic (serif). */
export interface BrandFontOption {
  id: string;
  label: string;
  group: "business" | "classic";
  /** Full CSS stack — written straight into --font-sans. */
  stack: string;
  /** Google Fonts family to load, or "" for a system face. */
  googleFamily: string;
  note: string;
}

export interface BrandThemeCatalog {
  presets: BrandColorPreset[];
  fonts: BrandFontOption[];
  defaults: { preset: string; font: string };
}

/** Where a brand's vanity domain stands. Only "verified" is used to build the
 *  links this brand sends — see server/src/services/brands.ts. */
export type BrandDomainStatus = "none" | "pending" | "verified" | "error";

/** One DNS record the brand's client pastes into their registrar. Mirrors DnsRecord in server/src/services/brandDomains.ts. */
export interface BrandDnsRecord {
  type: "CNAME" | "A" | "TXT";
  /** 1-based position in the client's checklist — the ownership TXT first. */
  step: number;
  /** What the step achieves, in the client's words. */
  title: string;
  /** Host/Name field as most registrars want it (the label, not the FQDN). */
  name: string;
  fqdn: string;
  value: string;
  /** What to put in the TTL column. */
  ttl: string;
  /** What this record type is, for someone who has never added one. */
  what: string;
  /** Why we need it. */
  why: string;
  /** Provider caveats worth passing on (Cloudflare proxying, ALIAS at a root). */
  notes: string[];
  /** False once we've observed this record resolving. */
  required: boolean;
  /** What DNS answers at this name INSTEAD of what we asked for — the old
   *  website, a stale token. Empty when unchecked, absent, or correct. */
  seen: string[];
}

/** The domain panel's whole state: what to publish and how far along it is. */
export interface BrandDomain {
  domain: string;
  status: BrandDomainStatus;
  /** A bare root (brand.com) rather than a subdomain — needs an A record and
   *  replaces whatever website lives there, so the panel warns. */
  apex: boolean;
  ownershipOk: boolean;
  routingOk: boolean;
  edgeOk: boolean;
  message: string;
  records: BrandDnsRecord[];
  checkedAt: string;
  /** Where the brand answers today (vanity domain once verified, else subdomain). */
  origin: string | null;
  /** Wildcard subdomain, live from creation. Carries the dev port on loopback ("acme.localhost:5174"). */
  platformHost: string;
  /** Reachable URL for `platformHost` (http + port on loopback). Always the subdomain, even once `origin` is a custom domain. */
  platformUrl: string;
  /** Path-routed fallback that needs no DNS at all. */
  pathUrl: string;
  /** The API host every brand's app talks to — the same for all of them. A
   *  brand's domain serves the SPA only; nothing API-side is per brand. */
  apiOrigin: string;
  /** False → the operator must add the hostname in the hosting dashboard. */
  edgeAutomated: boolean;
  /** Only on mutations: whether registering with the edge succeeded. */
  edgeMessage?: string;
}

/** The optional customer modules a brand may switch off. Mirrors
 *  server/src/services/brandSetup.ts — keep the two lists in step. */
export const BRAND_MODULES = [
  { id: "booking", label: "Booking", description: "Website booking module and calendar appointments." },
  { id: "transfer", label: "Call Transfer", description: "Hand a live call over to a human." },
  { id: "crm", label: "Connect CRM", description: "Lead delivery into the customer's own CRM." },
  { id: "smsToCaller", label: "SMS to Caller", description: "The AI texts callers the details they ask for mid-call." },
  { id: "whatsapp", label: "WhatsApp", description: "WhatsApp call summaries and inbound auto-replies." },
] as const;
export type BrandModuleId = (typeof BRAND_MODULES)[number]["id"];
export type BrandModules = Record<BrandModuleId, boolean>;
export type SignupMode = "public" | "invite";
export interface BrandScripts {
  head: string;
  body: string;
  footer: string;
}

/** One gap between a brand and "finished", and the tab that closes it. */
export interface BrandReadinessItem {
  id: string;
  label: string;
  done: boolean;
  hint: string;
  tab: string;
}
export interface BrandReadiness {
  items: BrandReadinessItem[];
  done: number;
  total: number;
}

/** A plan as a brand sells it: base + addon. The customer pays brandPriceCents to the platform; the addon share is credited to the brand's wallet per paid invoice. */
export interface BrandPricingRow {
  planId: string;
  planName: string;
  interval: string;
  intervalCount: number;
  currency: string;
  basePriceCents: number;
  addonCents: number;
  brandPriceCents: number;
  /** The brand's own Stripe Price exists for this plan. */
  stripeLinked: boolean;
  /** The platform plan has a Stripe product (a brand Price needs one). */
  planLinked: boolean;
  active: boolean;
  /** This brand's customers currently on the plan. */
  subscribers: number;
}
/** Outcome of moving a brand's existing subscribers onto its current Price. */
export interface ApplyPriceResult {
  priceId: string;
  moved: number;
  alreadyOn: number;
  skipped: { email: string; reason: string }[];
}
export interface BrandPricing {
  rows: BrandPricingRow[];
  addonEditable: boolean;
  maxAddonCents: number | null;
}
export type WalletEntryType = "credit" | "payout" | "reversal";
export interface WalletBalance {
  currency: string;
  balanceCents: number;
  creditedCents: number;
  paidOutCents: number;
}
export interface WalletEntry {
  id: string;
  type: WalletEntryType;
  amountCents: number;
  currency: string;
  stripeInvoiceId: string | null;
  /** On a reversal: the invoice whose credit it undid. */
  relatedInvoiceId: string | null;
  customerId: string | null;
  customerEmail: string | null;
  planId: string | null;
  planName: string | null;
  note: string;
  reference: string;
  createdAt: string;
}
export interface BrandWallet {
  balances: WalletBalance[];
  entries: WalletEntry[];
}

/** Ledger window totals: what customers paid, split platform (base) vs brand (addon). Per currency, since a brand can sell in several. */
export interface LedgerTotals {
  currency: string;
  payments: number;
  totalCents: number;
  platformCents: number;
  brandCents: number;
  refundedCents: number;
}
export interface LedgerBrandTotals extends LedgerTotals {
  brandId: string;
  brandName: string | null;
  brandSlug: string | null;
}
/** One paid invoice as the ledger records it. */
export interface LedgerRow {
  id: string;
  stripeInvoiceId: string;
  userId: string;
  customerEmail: string | null;
  planId: string | null;
  planName: string | null;
  couponId: string | null;
  currency: string;
  totalCents: number;
  platformCents: number;
  brandCents: number;
  refundedCents: number;
  periodStart: string | null;
  periodEnd: string | null;
  /** webhook | reconcile | renewal | go_live — which path booked it first. */
  source: string;
  paidAt: string;
}
export interface PlatformLedgerSummary {
  from: string;
  to: string;
  totals: LedgerTotals[];
  byBrand: LedgerBrandTotals[];
}
/* ---------------------- Platform views (phase 5) ---------------------- */

/** One brand's line on the super admin's overview — last night's rollup. */
export interface PlatformBrandRow {
  brandId: string;
  name: string;
  slug: string;
  status: string;
  /** The day the per-day numbers describe; null until the brand's first rollup. */
  day: string | null;
  computedAt: string | null;
  /** The newest row is older than last night's — the brand was skipped or unreachable. */
  stale: boolean;
  customers: number;
  active: number;
  trialing: number;
  callsTotal: number;
  minutesTotal: number;
  openTickets: number;
  calls: number;
  minutes: number;
}

export interface PlatformOverview {
  asOf: string | null;
  brands: { total: number; active: number; provisioning: number; failed: number; suspended: number };
  tenants: Record<string, number>;
  totals: { customers: number; active: number; trialing: number; callsTotal: number; minutesTotal: number; openTickets: number };
  perBrand: PlatformBrandRow[];
  series: { day: string; calls: number; minutes: number }[];
  ledger: { from: string; to: string; totals: LedgerTotals[] };
  wallets: { currency: string; balanceCents: number }[];
  unroutedEvents: number;
}

/** A person found in the thin directory — which brand they are in. */
export interface DirectoryHit {
  brandId: string;
  brand: { id: string; name: string; slug: string; status: string };
  userId: string;
  email: string;
  fullName: string;
  role: string;
  createdAt: string;
}

export interface BrandRef {
  id: string;
  name: string;
  slug: string;
}

export interface BrandCustomerRow {
  id: string;
  email: string;
  fullName: string;
  createdAt: string;
  businessName: string;
  plan: string;
  planName: string;
  subscriptionStatus: string;
  receptionistNumber: string;
  minutesUsed: number;
  onboarded: boolean;
}

export interface BrandCustomersPage {
  brand: BrandRef;
  page: number;
  pageSize: number;
  total: number;
  items: BrandCustomerRow[];
}

export interface BrandSubscriptionRow {
  userId: string;
  email: string;
  fullName: string;
  planId: string | null;
  planName: string;
  status: string;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  autoRenew: boolean;
  minutesAllocated: number | null;
  minutesUsed: number;
  updatedAt: string;
}

export interface BrandSubscriptionsView {
  brand: BrandRef;
  byStatus: { status: string; count: number }[];
  byPlan: { planId: string | null; planName: string; count: number }[];
  items: BrandSubscriptionRow[];
}

export interface BrandTicketRow {
  id: string;
  number: number;
  reference: string;
  subject: string;
  status: string;
  priority: string;
  lastMessageAt: string;
  createdAt: string;
  escalationId: string | null;
  requester: { id: string; email: string; fullName: string };
  department: { id: string; name: string } | null;
  assignedTo: { id: string; fullName: string } | null;
}

export interface BrandTicketsView {
  brand: BrandRef;
  byStatus: { status: string; count: number }[];
  items: BrandTicketRow[];
}

export interface BrandLedger {
  from: string;
  to: string;
  totals: LedgerTotals[];
  rows: LedgerRow[];
}
/** A Stripe event no brand could be found for — parked, waiting for the
 *  super admin to fix the customer's account and retry, or dismiss it. */
export interface UnroutedStripeEvent {
  id: string;
  stripeEventId: string;
  type: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  reason: string;
  receivedAt: string;
}

/** Brand lifecycle. Only `active` resolves a front door; `failed` means provisioning broke and Retry re-runs it;
 *  `deactivated` is off with a 30-day countdown to deletion (see `deletesAt`). */
export type BrandStatus = "active" | "suspended" | "provisioning" | "failed" | "deactivated";

/** The brand's own database, as its page shows it — never a connection string. */
export interface BrandTenantDb {
  provisioned: boolean;
  status: "none" | "provisioning" | "migrating" | "active" | "failed" | "disabled";
  /** `neon`: its own Neon project. `local-schema`: a schema on the platform's
   *  database (development, when Neon isn't configured). */
  provider: "neon" | "local-schema" | null;
  region: string;
  schemaName: string;
  neonProjectId: string;
  provisionedAt: string | null;
  migratedAt: string | null;
  /** Newest tenant migration applied vs. newest on disk. */
  schemaVersion: string;
  latestVersion: string;
  schemaCurrent: boolean;
  /** What the last provisioning attempt failed with, if it did. */
  error: string;
  /** Live round-trip, only on the dedicated endpoint. */
  health?: {
    reachable: boolean;
    identity: "ok" | "mismatch" | "unknown";
    calls: number;
    schemaCurrent: boolean;
    error: string;
  };
}

/** A brand as the super-admin panel sees it. */
export interface Brand {
  id: string;
  name: string;
  slug: string;
  customDomain: string | null;
  domainStatus: BrandDomainStatus;
  domainVerifiedAt: string | null;
  domainCheckedAt: string | null;
  domainError: string;
  /** Where this brand answers today. */
  origin: string;
  /** Its always-live subdomain under the platform apex. */
  platformHost: string;
  status: BrandStatus;
  /** ISO, set while deactivated. */
  deactivatedAt: string | null;
  /** ISO, when the sweep deletes a deactivated brand for good; null otherwise. */
  deletesAt: string | null;
  /** The brand's own database. On the detail and create responses. */
  tenantDb?: BrandTenantDb;
  logoLightUrl: string;
  logoDarkUrl: string;
  faviconUrl: string;
  themePreset: string;
  primaryColor: string;
  accentColor: string;
  fontFamily: string;
  fontStyle: string;
  darkModeDefault: boolean;
  tagline: string;
  supportEmail: string;
  supportPhone: string;
  /* ---- setup: policies, legal, content ---- */
  legalName: string;
  legalAddress: string;
  termsUrl: string;
  privacyUrl: string;
  websiteUrl: string;
  helpUrl: string;
  defaultCountry: string;
  defaultTimezone: string;
  signupMode: SignupMode;
  loginHeadline: string;
  loginBlurb: string;
  modules: BrandModules;
  planIds: string[];
  trialDays: number | null;
  trialMinutes: number | null;
  cardRequired: boolean | null;
  defaultVoiceId: string;
  scripts: BrandScripts;
  /** May the brand's own admin set its plan addons? */
  addonEditable: boolean;
  /** Most a brand may add per cycle, in cents; null = no cap. */
  maxAddonCents: number | null;
  createdAt: string;
  updatedAt: string;
  counts?: { admins: number; customers: number; total: number };
  /** On the list: what the platform currently owes this brand, per currency. */
  walletBalances?: { currency: string; balanceCents: number }[];
  /** Present on single-brand reads: what is still missing before it's finished. */
  readiness?: BrandReadiness;
  /** Present on single-brand reads: where this brand's users sign in. */
  loginUrl?: string;
  /** Present on single-brand reads: the no-DNS path-routed address. */
  pathUrl?: string;
}

/** The public slice /api/config returns for the host's brand — what the SPA
 *  paints itself with before anyone signs in. */
export interface PublicBrand {
  id: string;
  name: string;
  slug: string;
  tagline: string;
  supportEmail: string;
  supportPhone: string;
  logoLightUrl: string;
  logoDarkUrl: string;
  faviconUrl: string;
  theme: {
    preset: string;
    primaryColor: string;
    accentColor: string;
    fontFamily: string;
    fontStyle: string;
    fontStack: string;
    googleFamily: string;
    darkModeDefault: boolean;
  };
  websiteUrl: string;
  helpUrl: string;
  termsUrl: string;
  privacyUrl: string;
  legalName: string;
  /** "invite" → the sign-up screen is closed; the brand creates accounts. */
  signupMode: SignupMode;
  /** Sign-in screen copy; "" → the platform's default lines. */
  loginHeadline: string;
  loginBlurb: string;
  /** Which optional modules this brand's customers get. */
  modules: BrandModules;
}

/** One brand-overridable messaging field (mail / SMS / WhatsApp). */
export interface BrandIntegrationField {
  key: string;
  label: string;
  secret: boolean;
  placeholder: string;
  /** This brand set its own value. */
  isSet: boolean;
  /** Blank here — the platform's value is used instead. */
  inherited: boolean;
  /** Masked (last 4) — never the raw credential. */
  value: string;
}

export interface BrandIntegrationView {
  id: string;
  name: string;
  description: string;
  /** Every required key is overridden, so this channel stands on its own. */
  overridden: boolean;
  fields: BrandIntegrationField[];
}

export interface BrandAdmin {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  createdAt: string;
  /** Only on create: whether the welcome email actually went out. */
  emailSent?: boolean;
}

export interface BrandInput {
  name: string;
  slug?: string;
  customDomain?: string | null;
  status?: "active" | "suspended";
  tagline?: string;
  supportEmail?: string;
  supportPhone?: string;
  themePreset?: string;
  primaryColor?: string;
  accentColor?: string;
  fontFamily?: string;
  darkModeDefault?: boolean;
  legalName?: string;
  legalAddress?: string;
  termsUrl?: string;
  privacyUrl?: string;
  websiteUrl?: string;
  helpUrl?: string;
  defaultCountry?: string;
  defaultTimezone?: string;
  signupMode?: SignupMode;
  loginHeadline?: string;
  loginBlurb?: string;
  modules?: Partial<BrandModules>;
  planIds?: string[];
  trialDays?: number | null;
  trialMinutes?: number | null;
  cardRequired?: boolean | null;
  defaultVoiceId?: string;
  scripts?: Partial<BrandScripts>;
  addonEditable?: boolean;
  maxAddonCents?: number | null;
}

/** Pass as a field's value to hand that key back to the platform. */
export const BRAND_INHERIT = "__inherit__";

export const api = {
  /** A brand admin's own pricing addons and wallet — always the caller's brand. */
  brandAdmin: {
    pricing: () => get<BrandPricing>("/api/admin/brand/pricing"),
    setAddon: (planId: string, addonCents: number) =>
      put<BrandPricingRow>(`/api/admin/brand/pricing/${planId}`, { addonCents }),
    wallet: () => get<BrandWallet>("/api/admin/brand/wallet"),
  },
  /** Resolve a brand by the slug in the URL's first path segment. 404 when the
   *  segment isn't a live brand — the app then paints as the platform. */
  brandBySlug: (slug: string) => get<PublicBrand>(`/api/brand/${encodeURIComponent(slug)}`),
  config: () =>
    get<{
      vapiPublicKey: string;
      branding: Branding;
      scripts: SeoScripts;
      /** The host's white-label tenant, or null on the platform's own domain. */
      brand: PublicBrand | null;
    }>("/api/config"),
  onboard: {
    analyze: (url: string) => post<AnalyzeResult>("/api/onboard/analyze", { url }),
    validate: (url: string) => post<{ reachable: boolean }>("/api/onboard/validate", { url }),
  },
  bookings: {
    create: (data: {
      topic: string;
      name: string;
      email: string;
      phone?: string;
      preferredAt?: string;
      message?: string;
    }) => post<{ ok: true; id: string }>("/api/bookings", data),
  },
  auth: {
    register: (data: { email: string; password: string; fullName: string; businessName?: string; mobile?: string; businessNumber?: string; address?: string; referralCode?: string; timezone?: string }) =>
      post<AuthResponse>("/api/auth/register", { timezone: browserTimeZone(), ...data }),
    registerStart: (data: { email: string; password: string; fullName: string; businessName?: string; mobile?: string; businessNumber?: string; address?: string; referralCode?: string; viaOnboarding?: boolean; timezone?: string }) =>
      post<{ ok: true; email: string }>("/api/auth/register/start", { timezone: browserTimeZone(), ...data }),
    registerVerify: (data: { email: string; code: string }) =>
      post<AuthResponse>("/api/auth/register/verify", data),
    registerResend: (email: string) =>
      post<{ ok: true }>("/api/auth/register/resend", { email }),
    login: (data: { email: string; password: string }) =>
      post<AuthResponse>("/api/auth/login", data),
    me: () => get<{ user: AuthUser }>("/api/auth/me"),
    forgotPassword: (email: string) =>
      post<{ ok: true }>("/api/auth/forgot-password", { email }),
    resetPassword: (data: { email: string; code: string; newPassword: string }) =>
      post<AuthResponse>("/api/auth/reset-password", data),
    changePassword: (data: { currentPassword: string; newPassword: string }) =>
      post<{ ok: true }>("/api/auth/change-password", data),
  },
  profile: {
    get: () => get<Profile>("/api/profile"),
    update: (
      data: Partial<
        Pick<
          Profile,
          | "fullName"
          | "email"
          | "businessName"
          | "mobile"
          | "website"
          | "businessNumber"
          | "country"
          | "industry"
          | "forwardingMode"
        >
      > & { forwardingConfirmed?: boolean },
    ) => patch<Profile>("/api/profile", data),
    activateNumber: () => post<Profile>("/api/profile/activate-number"),
    /** Mark the quick-setup modal seen so it never auto-opens again. */
    markQuickSetupSeen: () => post<Profile>("/api/profile/quick-setup-seen"),
    /** Save guided-onboarding progress (resume step) or mark it complete. */
    onboardingProgress: (data: { step?: number; completed?: boolean }) =>
      patch<Profile>("/api/profile/onboarding", data),
    /** Real numbers from the connected Twilio pool, each flagged taken/mine. */
    availableNumbers: () =>
      get<{
        configured: boolean;
        numbers: { number: string; taken: boolean; mine: boolean }[];
        canBuyMore: boolean;
      }>("/api/profile/available-numbers"),
    /** Reserve a pool number for this user. `country` (ISO) is the onboarding
     *  selection, persisted to drive the assistant's regional style. */
    claimNumber: (number: string, country?: string) =>
      post<Profile>("/api/profile/claim-number", { number, country }),
    /** Allowed countries (ISO) + per-country prefixes for number selection. */
    numberCountries: () =>
      get<{ countries: string[]; prefixes: Record<string, string[]> }>(
        "/api/profile/number-countries",
      ),
    /** Live Twilio monthly pricing per number type for a country. */
    numberPricing: (country: string) =>
      get<{ currency: string; prices: Record<string, number> }>(
        `/api/profile/number-pricing?country=${encodeURIComponent(country)}`,
      ),
    /** Search Twilio for purchasable numbers (admin-gated). `prefix` narrows to a series, `q` + `match` search
     *  digits like Twilio's own picker; `q` wins over `prefix` server-side. */
    searchableNumbers: (
      country: string,
      opts?: { prefix?: string; q?: string; match?: NumberMatch; limit?: number },
    ) => {
      const params = new URLSearchParams({ country });
      if (opts?.prefix) params.set("prefix", opts.prefix);
      if (opts?.q) params.set("q", opts.q);
      if (opts?.q && opts.match) params.set("match", opts.match);
      if (opts?.limit) params.set("limit", String(opts.limit));
      return get<{ numbers: string[] }>(`/api/profile/searchable-numbers?${params.toString()}`);
    },
    /** Buy a brand-new number and assign it to this user (admin-gated). `country`
     *  (ISO) is persisted to drive the assistant's regional style. */
    buyNumber: (number: string, country?: string) =>
      post<Profile>("/api/profile/buy-number", { number, country }),
    usage: () =>
      get<{
        callsHandled: number;
        minutesUsed: number;
        planMinutes: number;
        percent: number;
        unlimited: boolean;
      }>("/api/profile/usage"),
  },
  agent: {
    get: () =>
      get<{ agentConfig: AgentConfig; vapiAssistantId: string | null; status: string; lastSyncedAt: string; promptTemplate?: string; promptTemplateIsLatest?: boolean }>(
        "/api/agent",
      ),
    save: (agentConfig: AgentConfig) =>
      put<{ agentConfig: AgentConfig; lastSyncedAt: string; vapiAssistantId: string | null; status: string; synced: boolean; syncError?: string; syncQueued?: boolean }>(
        "/api/agent",
        { agentConfig },
      ),
    persist: (agentConfig: AgentConfig) =>
      post<{ agentConfig: AgentConfig; lastSyncedAt: string }>("/api/agent/persist", { agentConfig }),
    adoptLatestTemplate: () =>
      post<{ agentConfig: AgentConfig; promptTemplate: string; promptTemplateIsLatest: boolean }>("/api/agent/adopt-latest-template"),
    sync: () => post<{ vapiAssistantId: string }>("/api/agent/sync"),
    /** Build the test-call payload SERVER-side so it runs the same wire prompt a real inbound call does.
     *  Pass the draft config so unsaved AI Brain edits are reflected. */
    testToken: (agentConfig?: AgentConfig) =>
      post<{ publicKeyConfigured: boolean; assistant: Record<string, unknown> }>(
        "/api/agent/test-token",
        agentConfig ? { agentConfig } : undefined,
      ),
    callRecording: (callId: string) =>
      get<{ recordingUrl: string | null }>(`/api/agent/call-recording/${callId}`),
  },
  voices: {
    /** Voice catalog annotated for the current user (entitlement + upsell hint). */
    list: () => get<VoiceCatalogResponse>("/api/voices"),
    listAll: () => get<AllVoicesResponse>("/api/voices/all"),
  },
  industries: {
    /** The AI-Brain industry options: built-ins + admin-approved customs. */
    list: () => get<IndustriesListResponse>("/api/industries"),
    /** Propose a custom industry — queued for admin review before it joins the list. */
    suggest: (value: string) =>
      post<IndustrySuggestResponse>("/api/industries/suggest", { value }),
  },
  calls: {
    list: (params: Record<string, string | number | undefined> = {}) => {
      const qs = new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== "") as [string, string][],
      ).toString();
      return get<{ calls: CallLog[]; total: number }>(`/api/calls${qs ? `?${qs}` : ""}`);
    },
    stats: (params: Record<string, string | undefined> = {}) => {
      const qs = new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== "") as [string, string][],
      ).toString();
      return get<{ total: number; successRate: number; avgDurationSec: number; missedRate: number }>(
        `/api/calls/stats${qs ? `?${qs}` : ""}`,
      );
    },
    get: (id: string) => get<CallLog>(`/api/calls/${id}`),
    create: (
      data: {
        type?: "Web" | "Phone";
        callerName?: string;
        callerNumber?: string;
        durationSec?: number;
        outcome?: "completed" | "missed" | "failed" | "voicemail";
        summary?: string;
        recordingUrl?: string;
        transcript?: unknown;
        analysis?: unknown;
      },
      // keepalive so the save survives an immediate page refresh after hang-up.
      opts?: { keepalive?: boolean },
    ) => post<CallLog>("/api/calls", data, opts?.keepalive ? { keepalive: true } : undefined),
    attachRecording: (id: string, recordingUrl: string) =>
      patch<CallLog>(`/api/calls/${id}`, { recordingUrl }),
    /** Enrich a just-saved web call with the AI summary (and recording) computed
     *  a moment after the fast, refresh-safe initial save. */
    update: (id: string, data: { summary?: string; recordingUrl?: string; analysis?: unknown }) =>
      patch<CallLog>(`/api/calls/${id}`, data),
    /** Correct a call's category. The server stamps it as owner-set so no later
     *  AI pass overwrites it. */
    setIntent: (id: string, intent: CallIntent) =>
      patch<CallLog>(`/api/calls/${id}/intent`, { intent }),
    summarize: (transcript: TranscriptTurn[]) =>
      post<{ summary: string }>("/api/calls/summarize", { transcript }),
    /** Translate a call's summary + transcript into the owner's report language
     *  (transcript cached server-side). `lang` is "" when no translation applies. */
    translate: (id: string) =>
      post<{ lang: string; transcript: TranscriptTurn[]; summary: string }>(
        `/api/calls/${id}/translate`,
      ),
    recording: (vapiCallId: string) =>
      get<{ recordingUrl: string | null }>(`/api/calls/recording?vapiCallId=${encodeURIComponent(vapiCallId)}`),
    /** Signed, short-lived proxy URL for the recording: <audio> can't send an auth header, so the URL is the capability. */
    /** `share: true` mints a longer-lived link for pasting to someone else; the dashboard's own token is short and re-minted per open. */
    recordingUrl: (id: string, share = false) =>
      get<{ url: string | null; expiresInDays?: number }>(
        `/api/calls/${id}/recording-url${share ? "?share=1" : ""}`,
      ),
  },
  notifications: {
    list: () => get<NotificationsListResponse>("/api/notifications"),
    markRead: (id: string) => post<OkResponse>(`/api/notifications/${id}/read`),
    markAllRead: () => post<OkResponse>("/api/notifications/read-all"),
    clear: () => del<OkResponse>("/api/notifications"),
    /** Which plan features the user has (email always true; customCrm gates webhook CRM). */
    channels: () => get<NotificationChannelsResponse>("/api/notifications/channels"),
    /** Send a dummy call-summary to the given destination to verify the channel works. */
    testSummary: (channel: "email" | "sms" | "whatsapp", to: string) =>
      post<TestSummaryResponse>("/api/notifications/test-summary", { channel, to }),
  },
  /** "My requests", requester side. The API picks the lane (customer -> brand team, brand admin -> platform)
   *  from the caller's role, so nothing here takes one; call `lane()` first for the on-screen wording. */
  tickets: {
    lane: () => get<TicketLaneInfo>("/api/tickets/lane"),
    departments: () => get<RequesterTicketDepartment[]>("/api/tickets/departments"),
    uploadPolicy: () => get<TicketUploadPolicy>("/api/tickets/upload-policy"),
    /** Stage a file. Returns the signed descriptor to replay when sending. */
    upload: (file: File, onProgress?: (p: number) => void, signal?: AbortSignal) =>
      uploadWithProgress<AttachmentDescriptor>("/api/tickets/uploads", file, {
        onProgress,
        signal,
      }),
    list: () => get<Ticket[]>("/api/tickets"),
    create: (data: {
      subject: string;
      departmentId: string;
      priority?: TicketPriority;
      message: string;
      attachments?: AttachmentDescriptor[];
    }) => post<Ticket>("/api/tickets", data),
    get: (id: string) => get<TicketThread>(`/api/tickets/${id}`),
    reply: (
      id: string,
      data: { body: string; attachments?: AttachmentDescriptor[]; replyToId?: string | null },
    ) => post<TicketMessage>(`/api/tickets/${id}/messages`, data),
    /** Fix a typo in my own message, inside the server's edit window. */
    editMessage: (id: string, messageId: string, body: string) =>
      patch<TicketMessage>(`/api/tickets/${id}/messages/${messageId}`, { body }),
    /** Take my own message back — it stays as a tombstone. */
    deleteMessage: (id: string, messageId: string) =>
      del<TicketMessage>(`/api/tickets/${id}/messages/${messageId}`),
    /** Toggle one emoji. Returns the whole message, reactions included. */
    react: (id: string, messageId: string, emoji: string) =>
      post<TicketMessage>(`/api/tickets/${id}/messages/${messageId}/reactions`, { emoji }),
    /** Fire-and-forget "…is typing" nudge for the handler's inbox. */
    typing: (id: string) => post<void>(`/api/tickets/${id}/typing`, {}),
    setStatus: (id: string, status: "open" | "closed") =>
      post<Ticket>(`/api/tickets/${id}/status`, { status }),
    /** "Did this help?" — only accepted once the request is resolved or closed. */
    rate: (id: string, rating: number, comment = "") =>
      post<Ticket>(`/api/tickets/${id}/rating`, { rating, comment }),
  },
  trial: {
    status: () => get<{ success: boolean } & TrialState>("/api/trial/status"),
  },
  crm: {
    get: () => get<CrmIntegration>("/api/crm"),
    update: (data: Partial<CrmIntegration>) => patch<CrmIntegration>("/api/crm", data),
    testWebhook: () =>
      post<{ success: boolean; status: number; errorMessage: string; durationMs: number }>(
        "/api/crm/test-webhook",
      ),
    deliveries: (page = 1, pageSize = 20) =>
      get<{ deliveries: WebhookDelivery[]; total: number }>(
        `/api/crm/deliveries?page=${page}&pageSize=${pageSize}`,
      ),
  },
  transfer: {
    get: () => get<HumanTransferSettings>("/api/transfer"),
    update: (
      data: Partial<
        Pick<
          HumanTransferSettings,
          "enabled" | "transferNumber" | "ringTimeoutSec" | "fallbackMessage"
        >
      >,
    ) => patch<HumanTransferSettings>("/api/transfer", data),
    departments: {
      list: () => get<TransferDepartment[]>("/api/transfer/departments"),
      /** Replace the whole department list in one atomic save. */
      replace: (
        departments: Pick<
          TransferDepartment,
          "name" | "number" | "description" | "enabled" | "ringTimeoutSec" | "fallbackMessage"
        >[],
      ) => put<TransferDepartment[]>("/api/transfer/departments", { departments }),
    },
  },
  google: {
    authUrl: () => get<{ url: string }>("/api/google/auth-url"),
    status: () => get<{ connected: boolean; email?: string }>("/api/google/status"),
    disconnect: () => post<{ ok: true }>("/api/google/disconnect"),
    /** Create + delete a test event to verify the calendar connection works. */
    test: () => post<{ ok: boolean; message: string }>("/api/google/test"),
  },
  booking: {
    overview: () => get<BookingOverview>("/api/booking/overview"),
    appointments: (params: { from?: string; to?: string; status?: string } = {}) => {
      const qs = new URLSearchParams(
        Object.entries(params).filter(([, v]) => v) as [string, string][],
      ).toString();
      return get<{ appointments: Appointment[] }>(`/api/booking/appointments${qs ? `?${qs}` : ""}`);
    },
    createAppointment: (data: {
      customerName?: string;
      customerPhone?: string;
      customerEmail?: string;
      notes?: string;
      startAt: string;
      endAt?: string;
    }) => post<Appointment>("/api/booking/appointments", data),
    cancelAppointment: (id: string) =>
      post<Appointment>(`/api/booking/appointments/${id}/cancel`),
    rescheduleAppointment: (id: string, data: { startAt: string; endAt?: string }) =>
      post<Appointment>(`/api/booking/appointments/${id}/reschedule`, data),
    settings: () => get<BookingSettings>("/api/booking/settings"),
    saveSettings: (data: {
      autoBookEnabled?: boolean;
      durationMin?: number;
      calendarId?: string;
      timezone?: string;
      hours?: WorkingHours;
    }) => put<BookingSettings & { synced: boolean }>("/api/booking/settings", data),
    /** Live booking tools + prompt for the browser test call. */
    toolConfig: () =>
      get<{ enabled: boolean; tools: unknown[]; promptSection: string }>(
        "/api/booking/tool-config",
      ),
  },
  chat: {
    get: () => get<{ conversation: { id: string }; messages: ChatMessage[] }>("/api/chat"),
    send: (content: string) => post<{ messages: ChatMessage[] }>("/api/chat/messages", { content }),
  },
  billing: {
    /** Stripe customer portal URL — 400s if the user has no Stripe customer yet. */
    portal: () => get<{ url: string }>("/api/billing/portal"),
    /** Public — active plans for the signup picker. */
    plans: () => get<SubscriptionPlan[]>("/api/billing/plans"),
    /** Public — the global free-trial terms (days + minutes) for the subscribe page. */
    trialInfo: () => get<{ days: number; minutes: number }>("/api/billing/trial-info"),
    /** Check a coupon code against a plan. Read-only — reserves nothing, so it's
     *  safe to call as the user types. */
    validateCoupon: (code: string, planId: string) =>
      post<CouponValidation>("/api/billing/coupon/validate", { code, planId }),
    /** Start a trial subscription; returns a SetupIntent client secret. `couponCode` is re-validated server-side
     *  and rejected outright if stale, so nobody reaches the card step expecting a missing discount. */
    subscribe: (planId: string, autoRenew = true, couponCode?: string) =>
      post<{ clientSecret: string | null; subscriptionId: string }>("/api/billing/subscribe", {
        planId,
        autoRenew,
        ...(couponCode ? { couponCode } : {}),
      }),
    /** Confirm the saved card + activate. `charged` = the card was billed now (trial used up);
     *  `activateNow` = the user explicitly bought a plan, so charge immediately instead of continuing the trial. */
    confirmCard: (paymentMethodId: string, activateNow?: boolean) =>
      post<{ ok: true; charged: boolean }>("/api/billing/confirm-card", {
        paymentMethodId,
        ...(activateNow ? { activateNow } : {}),
      }),
    /** Subscription details for the settings page. */
    subscription: () => get<{ subscription: SubscriptionDetail | null }>("/api/billing/subscription"),
    /** Turn auto-renew (auto-charge on expiry) on/off. */
    setAutoRenew: (enabled: boolean) =>
      post<{ ok: true; autoRenew: boolean; message: string }>("/api/billing/auto-renew", { enabled }),
    /** Renew the current (blocked) plan now — charges the saved card, resets
     *  minutes, turns auto-renew back on. Keeps the same plan (no trial). */
    renew: () => post<{ ok: true; message: string }>("/api/billing/renew"),
    /** Recent invoices from Stripe. */
    invoices: () => get<{ invoices: Invoice[] }>("/api/billing/invoices"),
    /** Preview a plan change — credit + exact amount due + effective date. No charge. */
    changePlanPreview: (planId: string) =>
      post<PlanChangePreview>("/api/billing/change-plan/preview", { planId }),
    /** Apply a plan change (upgrade now / downgrade at period end / swap trial plan). */
    changePlan: (planId: string) =>
      post<{ ok: true; direction: string; message: string; chargedCents?: number; creditCents?: number }>(
        "/api/billing/change-plan",
        { planId },
      ),

    // Cross-currency switch: Stripe locks a customer to one currency, so this needs a NEW subscription
    // with a re-entered card. Three steps in order; the existing plan stays live until `confirm`.

    /** Open the new subscription unpaid and get a PaymentIntent to confirm.
     *  Charges nothing and leaves the current plan untouched. */
    switchCurrencyStart: (planId: string) =>
      post<{
        clientSecret: string | null;
        subscriptionId: string;
        plan: {
          id: string;
          name: string;
          priceCents: number;
          currency: string;
          interval: string;
          includedMinutes: number;
        };
        /** Always true — Stripe can't credit unused time across currencies. */
        losesRemainingTime: boolean;
        currentPlan: { name: string; currency: string };
      }>("/api/billing/switch-currency/start", { planId }),

    /** Finish the switch after the payment succeeds. The server re-checks with
     *  Stripe before cancelling the old subscription. */
    switchCurrencyConfirm: () =>
      post<{ ok: true; planId: string; planName: string }>("/api/billing/switch-currency/confirm", {}),

    /** Abandon a started switch and tidy up the unpaid subscription. */
    switchCurrencyCancel: () =>
      post<{ ok: true }>("/api/billing/switch-currency/cancel", {}),
    /** Cancel a pending downgrade — stay on the current plan. */
    cancelDowngrade: () =>
      post<{ ok: true; message: string }>("/api/billing/change-plan/cancel-downgrade"),
  },
  // Super admin only: the white-label brand panel. Every call here 403s for a brand ADMIN.
  super: {
    brands: {
      list: () => get<Brand[]>("/api/super/brands"),
      get: (id: string) => get<Brand>(`/api/super/brands/${id}`),
      /** Colour presets + font catalog powering the theme pickers. */
      catalog: () => get<BrandThemeCatalog>("/api/super/brands/catalog"),
      /** Live subdomain availability while the operator types. */
      checkSlug: (slug: string, brandId?: string) =>
        get<{ slug: string; available: boolean; reason: string; url: string }>(
          `/api/super/brands/slug-check?slug=${encodeURIComponent(slug)}${
            brandId ? `&brandId=${encodeURIComponent(brandId)}` : ""
          }`,
        ),
      /** Create the brand and, in the same step, its administrator — so a brand
       *  is never left standing with no way in. */
      create: (
        data: BrandInput & {
          admin?: { email: string; fullName: string; password: string; sendWelcomeEmail?: boolean };
        },
      ) =>
        post<{
          brand: Brand;
          admin: BrandAdmin | null;
          /** Why no admin was created although one was typed; empty otherwise. */
          adminError?: string;
          loginUrl: string;
          pathUrl: string;
          /** Present only when a vanity domain was named in the same step. */
          domain: BrandDomain | null;
        }>("/api/super/brands", data),
      update: (id: string, data: Partial<BrandInput>) =>
        patch<Brand>(`/api/super/brands/${id}`, data),
      /** Immediate and final: the brand's database, and every account in it, goes with the row. */
      remove: (id: string) =>
        del<{ ok: true; accountsRemoved: number }>(`/api/super/brands/${id}`),
      /** Off now, deleted (database included) 30 days on unless reactivated. Returns the detail payload. */
      deactivate: (id: string) => post<Brand>(`/api/super/brands/${id}/deactivate`, {}),
      reactivate: (id: string) => post<Brand>(`/api/super/brands/${id}/reactivate`, {}),
      /** The brand's own database: state, and a Retry for a failed setup. */
      tenantDb: {
        get: (id: string) => get<BrandTenantDb>(`/api/super/brands/${id}/tenant-db`),
        /** Slow and inline on purpose — the operator is watching. */
        retry: (id: string) =>
          post<{ brand: Brand; tenantDb: BrandTenantDb }>(`/api/super/brands/${id}/tenant-db`, {}),
      },
      uploadAsset: (id: string, slot: "logoLight" | "logoDark" | "favicon", file: File) => {
        const form = new FormData();
        form.append("file", file);
        return upload<Brand>(`/api/super/brands/${id}/assets/${slot}`, form);
      },
      clearAsset: (id: string, slot: "logoLight" | "logoDark" | "favicon") =>
        del<Brand>(`/api/super/brands/${id}/assets/${slot}`),
      // Vanity domains. The subdomain needs none of this; these drive the panel for a client-owned domain.
      /** Records to publish + claim status. Cheap unless `live`, which runs a real DNS check so the panel opens on the truth. */
      domain: (id: string, opts?: { live?: boolean }) =>
        get<BrandDomain>(`/api/super/brands/${id}/domain${opts?.live ? "?live=1" : ""}`),
      /** Claim, replace, or (with "") clear the vanity domain. */
      setDomain: (id: string, domain: string) =>
        put<BrandDomain>(`/api/super/brands/${id}/domain`, { domain }),
      /** Live DNS + edge check. This is what promotes a claim to "verified". */
      verifyDomain: (id: string) =>
        post<BrandDomain>(`/api/super/brands/${id}/domain/verify`, {}),
      /* ------------------------ Pricing & wallet ----------------------- */
      pricing: (id: string) => get<BrandPricing>(`/api/super/brands/${id}/pricing`),
      setAddon: (id: string, planId: string, addonCents: number) =>
        put<BrandPricingRow>(`/api/super/brands/${id}/pricing/${planId}`, { addonCents }),
      /** Move the brand's existing subscribers on a plan onto its current Price. */
      applyPricing: (id: string, planId: string) =>
        post<ApplyPriceResult>(`/api/super/brands/${id}/pricing/${planId}/apply`, {}),
      wallet: (id: string) => get<BrandWallet>(`/api/super/brands/${id}/wallet`),
      /** This brand's payments from the platform ledger: this month's totals and the latest rows. */
      ledger: (id: string) => get<BrandLedger>(`/api/super/brands/${id}/ledger`),
      // Inside the brand: these read from that tenant's database and nothing else.
      customers: (id: string, opts?: { q?: string; page?: number; pageSize?: number }) =>
        get<BrandCustomersPage>(`/api/super/brands/${id}/customers${opts ? toQuery(opts) : ""}`),
      subscriptions: (id: string) => get<BrandSubscriptionsView>(`/api/super/brands/${id}/subscriptions`),
      tickets: (id: string, status?: string) =>
        get<BrandTicketsView>(`/api/super/brands/${id}/tickets${status ? toQuery({ status }) : ""}`),
      /** Record a payout the platform made to the brand by hand. */
      payout: (
        id: string,
        data: { amountCents: number; currency: string; reference?: string; note?: string },
      ) =>
        post<{ entry: WalletEntry; balances: WalletBalance[] }>(
          `/api/super/brands/${id}/wallet/payouts`,
          data,
        ),
      /** Masked view of what this brand white-labels vs. inherits. */
      integrations: (id: string) =>
        get<BrandIntegrationView[]>(`/api/super/brands/${id}/integrations`),
      /** Blank/masked values mean "unchanged"; BRAND_INHERIT hands a key back. */
      saveIntegrations: (id: string, updates: Record<string, string>) =>
        put<BrandIntegrationView[]>(`/api/super/brands/${id}/integrations`, updates),
      clearIntegration: (id: string, integrationId: string) =>
        del<BrandIntegrationView[]>(`/api/super/brands/${id}/integrations/${integrationId}`),
      admins: (id: string) => get<BrandAdmin[]>(`/api/super/brands/${id}/admins`),
      addAdmin: (
        id: string,
        data: { email: string; fullName: string; password: string; sendWelcomeEmail?: boolean },
      ) => post<BrandAdmin>(`/api/super/brands/${id}/admins`, data),
      /** Deletes the account: every account belongs to a brand, so leaving the
       *  brand is leaving the platform. */
      removeAdmin: (id: string, userId: string) =>
        del<{ ok: true }>(`/api/super/brands/${id}/admins/${userId}`),
      /** The brand's support queues. Which queues exist is the platform's call; the brand admin only assigns who works them. */
      ticketDepartments: {
        list: (id: string) =>
          get<AdminTicketDepartment[]>(`/api/super/brands/${id}/ticket-departments`),
        create: (id: string, data: BrandTicketDepartmentInput) =>
          post<AdminTicketDepartment>(`/api/super/brands/${id}/ticket-departments`, data),
        update: (id: string, deptId: string, data: Partial<BrandTicketDepartmentInput>) =>
          patch<AdminTicketDepartment>(`/api/super/brands/${id}/ticket-departments/${deptId}`, data),
        remove: (id: string, deptId: string) =>
          del<{ ok: true }>(`/api/super/brands/${id}/ticket-departments/${deptId}`),
      },
    },
    /** What the platform earned in a window (this month by default), overall and per brand. */
    ledger: (window?: { from?: string; to?: string }) =>
      get<PlatformLedgerSummary>(`/api/super/ledger${window ? toQuery(window) : ""}`),
    stripe: {
      /** Stripe events waiting for a brand. Empty is the healthy state. */
      unrouted: () => get<{ events: UnroutedStripeEvent[] }>("/api/super/stripe/unrouted"),
      /** Apply a parked event now that its customer can be placed. */
      retry: (id: string) => post<{ ok: true; brandId: string }>(`/api/super/stripe/unrouted/${id}/retry`, {}),
      dismiss: (id: string) => post<{ ok: true }>(`/api/super/stripe/unrouted/${id}/dismiss`, {}),
    },
    /** The platform as a whole, from Main alone — as of the last nightly rollup. */
    overview: () => get<PlatformOverview>("/api/super/overview"),
    /** Visit every brand's database now and refresh today's numbers. */
    rollup: () => post<{ day: string; brands: number; failed: string[] }>("/api/super/stats/rollup", {}),
    /** Find a person by email or name, whichever brand they are in. */
    directory: (q: string) =>
      get<{ q: string; hits: DirectoryHit[] }>(`/api/super/directory${toQuery({ q })}`),
  },
  admin: {
    overview: () => get<AdminOverview>("/api/admin/overview"),
    customers: (search?: string) =>
      get<Customer[]>(`/api/admin/customers${search ? `?search=${encodeURIComponent(search)}` : ""}`),
    customer: (id: string) => get<Customer>(`/api/admin/customers/${id}`),
    updateCustomer: (id: string, data: { plan?: "free" | "premium" }) =>
      patch<Customer>(`/api/admin/customers/${id}`, data),
    deleteCustomer: (id: string) => del<{ ok: true }>(`/api/admin/customers/${id}`),
    suspendCustomer: (id: string, reason?: string) =>
      post<Customer>(`/api/admin/customers/${id}/suspend`, reason ? { reason } : undefined),
    reactivateCustomer: (id: string) => post<Customer>(`/api/admin/customers/${id}/reactivate`),
    /** The PIN is verified server-side inside this endpoint — sending it is not
     *  a formality the client could skip. */
    impersonate: (id: string, pin: string) =>
      post<{ token: string; user: AuthUser }>(`/api/admin/customers/${id}/impersonate`, { pin }),
    impersonationPin: {
      status: () => get<{ isDefault: boolean; lockedForMs: number }>("/api/admin/impersonation-pin"),
      change: (currentPin: string, newPin: string) =>
        put<{ ok: true; isDefault: false }>("/api/admin/impersonation-pin", {
          currentPin,
          newPin,
        }),
      /** Emails a one-time code to the admin's OWN address — the server reads it
       *  from the session, so there is nothing to pass here. */
      startReset: () =>
        post<{ ok: true; sentTo: string }>("/api/admin/impersonation-pin/reset/start"),
      completeReset: (code: string, newPin: string) =>
        post<{ ok: true; isDefault: false }>("/api/admin/impersonation-pin/reset/complete", {
          code,
          newPin,
        }),
    },
    subscriptions: {
      list: () => get<AdminSubscriptionsResponse>("/api/admin/subscriptions"),
      detail: (userId: string) =>
        get<AdminSubscriptionDetail>(`/api/admin/subscriptions/${userId}`),
    },
    integrations: () => get<IntegrationView[]>("/api/admin/integrations"),
    saveIntegrations: (updates: Record<string, string>) =>
      put<IntegrationView[]>("/api/admin/integrations", { updates }),
    clearIntegration: (id: string) =>
      del<IntegrationView[]>(`/api/admin/integrations/${id}`),
    coupons: {
      list: () => get<Coupon[]>("/api/admin/coupons"),
      redemptions: (id: string) =>
        get<CouponRedemptionRow[]>(`/api/admin/coupons/${id}/redemptions`),
      create: (data: CouponInput) => post<Coupon>("/api/admin/coupons", data),
      update: (id: string, data: Partial<CouponInput>) =>
        patch<Coupon>(`/api/admin/coupons/${id}`, data),
      remove: (id: string) => del<{ ok: true }>(`/api/admin/coupons/${id}`),
      /** The customer's live discount + every active coupon annotated with
       *  whether it can be granted to them. One call for the Discount card. */
      forCustomer: (userId: string) =>
        get<CustomerCouponState>(`/api/admin/customers/${userId}/coupon`),
      /** Grant a coupon directly (retention/comp). `override` is required for one outside its window or
       *  restricted to other plans; the server refuses without it. */
      grant: (userId: string, couponId: string, override = false) =>
        post<{ ok: true }>(`/api/admin/customers/${userId}/coupon`, {
          couponId,
          ...(override ? { override: true } : {}),
        }),
      /** Remove a customer's live discount. `releaseSlot` lets them redeem that
       *  code again — the undo for a coupon granted by mistake. */
      revoke: (userId: string, releaseSlot = false) =>
        del<{ ok: true; releaseSlot: boolean }>(
          `/api/admin/customers/${userId}/coupon?releaseSlot=${releaseSlot}`,
        ),
    },
    voiceCategories: {
      list: () => get<VoiceCategory[]>("/api/admin/voice-categories"),
      create: (title: string, voiceIds: string[]) =>
        post<VoiceCategory>("/api/admin/voice-categories", { title, voiceIds }),
      update: (id: string, title: string, voiceIds: string[]) =>
        put<VoiceCategory>(`/api/admin/voice-categories/${id}`, { title, voiceIds }),
      remove: (id: string) => del<{ ok: boolean }>(`/api/admin/voice-categories/${id}`),
    },
    testEmail: (to?: string) =>
      post<{ success: boolean; to?: string; message?: string }>(
        "/api/admin/integrations/email/test",
        to ? { to } : {},
      ),
    branding: {
      get: () => get<BrandingState>("/api/admin/branding"),
      upload: (slot: BrandingSlot, file: File) => {
        const form = new FormData();
        form.append("file", file);
        return upload<BrandingState>(`/api/admin/branding/${slot}`, form);
      },
      clear: (slot: BrandingSlot) => del<BrandingState>(`/api/admin/branding/${slot}`),
    },
    emails: {
      list: () =>
        get<{ templates: EmailTemplate[]; branding: EmailBranding }>("/api/admin/emails"),
      update: (key: string, data: Partial<Pick<EmailTemplate, "subject" | "body" | "enabled">>) =>
        patch<EmailTemplate>(`/api/admin/emails/${key}`, data),
      preview: (key: string) =>
        get<{ subject: string; html: string; text: string; enabled: boolean; alwaysOn: boolean }>(
          `/api/admin/emails/${key}/preview`,
        ),
      test: (key: string, to?: string) =>
        post<{ success: boolean; to?: string }>(`/api/admin/emails/${key}/test`, to ? { to } : {}),
      saveBranding: (data: Partial<EmailBranding>) =>
        put<EmailBranding>("/api/admin/email-branding", data),
    },
    testNexleonCrm: () =>
      post<{ success: boolean; status: number; errorMessage: string; durationMs: number }>(
        "/api/admin/integrations/perfex/test",
      ),
    testWhatsApp: (to: string) =>
      post<{ success: boolean; message: string }>(
        "/api/admin/integrations/whatsapp/test",
        { to },
      ),
    verifyWhatsApp: () =>
      post<{ success: boolean; message: string }>("/api/admin/integrations/whatsapp/verify"),
    whatsAppInfo: () =>
      get<{ webhookUrl: string }>("/api/admin/integrations/whatsapp/info"),
    plans: {
      list: () => get<SubscriptionPlan[]>("/api/admin/plans"),
      create: (data: PlanInput) => post<SubscriptionPlan>("/api/admin/plans", data),
      update: (id: string, data: Partial<PlanInput>) =>
        patch<SubscriptionPlan>(`/api/admin/plans/${id}`, data),
      remove: (id: string) => del<{ ok: true }>(`/api/admin/plans/${id}`),
      syncStripe: () =>
        post<{ results: Array<{ id: string; name: string; synced: boolean; error?: string }> }>(
          "/api/admin/plans/sync-stripe",
        ),
    },
    trialDays: {
      get: () => get<{ days: number }>("/api/admin/trial-days"),
      set: (days: number) => put<{ days: number }>("/api/admin/trial-days", { days }),
    },
    trialMinutes: {
      get: () => get<{ minutes: number }>("/api/admin/trial-minutes"),
      set: (minutes: number) => put<{ minutes: number }>("/api/admin/trial-minutes", { minutes }),
    },
    gracePeriod: {
      get: () => get<{ enabled: boolean; days: number }>("/api/admin/grace-period"),
      set: (enabled: boolean, days: number) =>
        put<{ enabled: boolean; days: number }>("/api/admin/grace-period", { enabled, days }),
    },
    /** Platform-wide ceiling on how long any single call may run. Stored in
     *  seconds; the UI edits minutes. */
    callDurationCap: {
      get: () => get<{ enabled: boolean; seconds: number }>("/api/admin/call-duration-cap"),
      set: (enabled: boolean, seconds: number) =>
        put<{ enabled: boolean; seconds: number }>("/api/admin/call-duration-cap", {
          enabled,
          seconds,
        }),
    },
    promptTemplate: {
      get: () =>
        get<{ template: string; default: string; isDefault: boolean; preview: string }>(
          "/api/admin/prompt-template",
        ),
      set: (template: string) =>
        put<{ template: string; default: string; isDefault: boolean; preview: string }>(
          "/api/admin/prompt-template",
          { template },
        ),
      history: () =>
        get<{
          versions: {
            id: number;
            template: string;
            isDefault: boolean;
            chars: number;
            replacedAt: string;
            replacedBy: string;
          }[];
        }>("/api/admin/prompt-template/history"),
    },
    seo: {
      get: () => get<{ scripts: SeoScripts }>("/api/admin/seo"),
      set: (scripts: SeoScripts) => put<{ scripts: SeoScripts }>("/api/admin/seo", { scripts }),
    },
    countryStyles: {
      get: () =>
        get<{ styles: Record<string, string>; builtins: Record<string, string> }>(
          "/api/admin/country-styles",
        ),
      set: (styles: Record<string, string>) =>
        put<{ styles: Record<string, string>; builtins: Record<string, string> }>(
          "/api/admin/country-styles",
          { styles },
        ),
    },
    industries: {
      /** Approved custom entries + the pending-review queue. */
      list: () => get<IndustryAdminView>("/api/admin/industries"),
      /** Approve a pending suggestion → it joins the public list. */
      approve: (value: string) => post<IndustryAdminView>("/api/admin/industries/approve", { value }),
      /** Reject (drop) a pending suggestion. */
      reject: (value: string) => post<IndustryAdminView>("/api/admin/industries/reject", { value }),
      /** Remove a previously-approved custom industry (built-ins stay). */
      remove: (value: string) => del<IndustryAdminView>("/api/admin/industries", { value }),
    },
    agentDefaultNames: {
      get: () => get<{ male: string; female: string }>("/api/admin/agent-default-names"),
      set: (male: string, female: string) =>
        put<{ male: string; female: string }>("/api/admin/agent-default-names", { male, female }),
    },
    agentLlm: {
      // Providers/models are fetched live from Vapi server-side; `refresh` forces
      // the server to bypass its cache and re-pull Vapi's current catalogue.
      get: (refresh = false) =>
        get<AgentLlmSettings>(`/api/admin/agent-llm${refresh ? "?refresh=true" : ""}`),
      set: (provider: string, model: string) =>
        put<AgentLlmSettings>("/api/admin/agent-llm", { provider, model }),
    },
    transcriberFallback: {
      // Transcriber options refresh live from Vapi; `refresh` forces a re-pull.
      get: (refresh = false) =>
        get<TranscriberFallbackSettings>(
          `/api/admin/transcriber-fallback${refresh ? "?refresh=true" : ""}`,
        ),
      set: (data: { autoFallback: boolean; provider: string; model: string }) =>
        put<TranscriberFallbackSettings>("/api/admin/transcriber-fallback", data),
    },
    /** Onboarding policy. `cardRequired` applies to NEW signups only; every account snapshots it at creation. */
    onboarding: {
      get: () => get<{ cardRequired: boolean }>("/api/admin/onboarding"),
      set: (cardRequired: boolean) =>
        put<{ cardRequired: boolean }>("/api/admin/onboarding", { cardRequired }),
    },
    resellers: {
      list: () => get<Reseller[]>("/api/admin/resellers"),
      create: (data: { email: string; fullName: string; password: string; commissionPercent: number }) =>
        post<Reseller>("/api/admin/resellers", data),
      update: (id: string, data: { fullName?: string; commissionPercent?: number }) =>
        patch<Reseller>(`/api/admin/resellers/${id}`, data),
      remove: (id: string) => del<{ ok: true }>(`/api/admin/resellers/${id}`),
    },
    audit: (
      params: {
        action?: string;
        search?: string;
        from?: string;
        to?: string;
        page?: number;
        pageSize?: number;
      } = {},
    ) => {
      const qs = new URLSearchParams();
      if (params.action) qs.set("action", params.action);
      if (params.search) qs.set("search", params.search);
      if (params.from) qs.set("from", params.from);
      if (params.to) qs.set("to", params.to);
      if (params.page) qs.set("page", String(params.page));
      if (params.pageSize) qs.set("pageSize", String(params.pageSize));
      const q = qs.toString();
      return get<AuditLogPage>(`/api/admin/audit${q ? `?${q}` : ""}`);
    },
    webhookDeliveries: (status: WebhookDeliveryStatus = "all", limit = 100) =>
      get<WebhookDeliveryLog[]>(`/api/admin/webhook-deliveries?status=${status}&limit=${limit}`),
    retryWebhook: (id: string) =>
      post<{ success: boolean; status: number; errorMessage: string; durationMs: number }>(
        `/api/admin/webhook-deliveries/${id}/retry`,
      ),
    systemHealth: () => get<SystemHealth>("/api/admin/system-health"),
    customerDetail: (id: string) => get<CustomerDetail>(`/api/admin/customers/${id}/detail`),
    sendDigests: () => post<{ sent: number; skipped: number }>("/api/admin/reports/send-digests"),
    reportsLastRun: () => get<{ lastRunAt: string | null }>("/api/admin/reports/last-run"),
    previewDigest: (userId: string) => get<UserDigest>(`/api/admin/reports/preview/${userId}`),
    phoneNumbers: {
      overview: () => get<PhoneOverview>("/api/admin/phones/overview"),
      agents: () => get<PhoneAgent[]>("/api/admin/phones/agents"),
      twilioAvailable: () => get<PhoneImportable[]>("/api/admin/phones/twilio-available"),
      twilioSearch: (params: {
        country?: string;
        areaCode?: string;
        contains?: string;
        type?: "local" | "mobile";
        prefix?: string;
      }) => {
        const q = new URLSearchParams(
          Object.entries(params).filter(([, v]) => v) as [string, string][],
        ).toString();
        return get<PhoneImportable[]>(`/api/admin/phones/twilio-search${q ? `?${q}` : ""}`);
      },
      addSystem: (data: { number: string; sid?: string; purchase?: boolean }) =>
        post<PhonePoolNumber>("/api/admin/phones/add-system", data),
      /** Route a number to an agent (naming the brand whose database holds it), or back to the pool. */
      reassign: (id: string, agentId: string | null, brandId?: string | null) =>
        post<PhoneOverview>(`/api/admin/phones/${id}/reassign`, agentId ? { agentId, ...(brandId ? { brandId } : {}) } : {}),
      assignSms: (number: string) =>
        post<{ smsSender: string }>("/api/admin/phones/assign-sms", { number }),
      unassignSms: () => post<{ smsSender: null }>("/api/admin/phones/unassign-sms"),
      testSms: (to: string) =>
        post<{ ok: true; from: string; to: string }>("/api/admin/phones/test-sms", { to }),
      cleanupOrphaned: () =>
        post<{ removed: number; numbers: string[] }>("/api/admin/phones/cleanup-orphaned"),
      clearSync: () =>
        post<{ changed: number; numbers: string[] }>("/api/admin/phones/clear-sync"),
      resyncTwilio: () =>
        post<PhoneResync>("/api/admin/phones/resync-twilio"),
      replenishConfig: () => get<PhoneReplenishConfig>("/api/admin/phones/replenish-config"),
      saveReplenishConfig: (data: Partial<PhoneReplenishConfig>) =>
        put<PhoneReplenishConfig>("/api/admin/phones/replenish-config", data),
      replenish: () => post<PhoneReplenishResult>("/api/admin/phones/replenish"),
    },
    staff: {
      list: () => get<StaffMember[]>("/api/admin/staff"),
      get: (id: string) => get<StaffMember>(`/api/admin/staff/${id}`),
      create: (data: {
        email: string;
        fullName: string;
        password: string;
        roleId?: string;
        permissions?: string[];
        ticketDepartmentIds?: string[];
      }) => post<StaffMember>("/api/admin/staff", data),
      update: (
        id: string,
        data: {
          fullName?: string;
          roleId?: string | null;
          permissions?: string[];
          /** Omit to leave personal queue grants alone; send all to replace. */
          ticketDepartmentIds?: string[];
        },
      ) => patch<StaffMember>(`/api/admin/staff/${id}`, data),
      remove: (id: string) => del<{ ok: true }>(`/api/admin/staff/${id}`),
      permissions: () => get<PermissionsConfig>("/api/admin/permissions"),
    },
    roles: {
      list: () => get<StaffRole[]>("/api/admin/roles"),
      get: (id: string) => get<StaffRole>(`/api/admin/roles/${id}`),
      create: (data: {
        name: string;
        description?: string;
        permissions: string[];
        departmentIds?: string[];
      }) => post<StaffRole>("/api/admin/roles", data),
      update: (
        id: string,
        data: {
          name?: string;
          description?: string;
          permissions?: string[];
          departmentIds?: string[];
        },
      ) => patch<StaffRole>(`/api/admin/roles/${id}`, data),
      remove: (id: string) => del<{ ok: true }>(`/api/admin/roles/${id}`),
    },

    /** Handler inbox (brand admin's customer queue, or the super admin's brand-request queue). The API
     *  resolves the lane from the caller's role, so no call here names one. */
    tickets: {
      lane: () => get<TicketLaneInfo>("/api/admin/tickets/lane"),
      list: (params: AdminTicketListParams = {}) =>
        get<TicketListPage>(`/api/admin/tickets${toQuery({ ...params })}`),
      stats: () => get<TicketStats>("/api/admin/tickets/stats"),
      /** The table as a file — every ticket matching the filters, not just the page. */
      exportCsv: (params: AdminTicketListParams = {}) =>
        download(
          `/api/admin/tickets/export.csv${toQuery({ ...params })}`,
          `tickets-${new Date().toISOString().slice(0, 10)}.csv`,
        ),
      ratings: (
        params: {
          departmentId?: string;
          stars?: number;
          poorOnly?: boolean;
          page?: number;
          pageSize?: number;
        } = {},
      ) => get<TicketRatingsPage>(`/api/admin/tickets/ratings${toQuery({ ...params })}`),
      get: (id: string) => get<TicketThread>(`/api/admin/tickets/${id}`),
      /** Raise one on someone's behalf — a request that came in another way. */
      create: (data: {
        subject: string;
        departmentId: string;
        priority?: TicketPriority;
        message: string;
        requesterId: string;
        attachments?: AttachmentDescriptor[];
      }) => post<Ticket>("/api/admin/tickets", data),
      reply: (
        id: string,
        data: {
          body: string;
          internal?: boolean;
          attachments?: AttachmentDescriptor[];
          replyToId?: string | null;
        },
      ) => post<TicketMessage>(`/api/admin/tickets/${id}/messages`, data),
      editMessage: (id: string, messageId: string, body: string) =>
        patch<TicketMessage>(`/api/admin/tickets/${id}/messages/${messageId}`, { body }),
      /** Remove a message: mine always, anyone's with `tickets.delete` (how a card number gets pulled out of a thread). */
      deleteMessage: (id: string, messageId: string) =>
        del<TicketMessage>(`/api/admin/tickets/${id}/messages/${messageId}`),
      react: (id: string, messageId: string, emoji: string) =>
        post<TicketMessage>(`/api/admin/tickets/${id}/messages/${messageId}/reactions`, { emoji }),
      typing: (id: string) => post<void>(`/api/admin/tickets/${id}/typing`, {}),
      /** Escalate to the platform (brand admins only): opens a NEW linked ticket on the platform lane in the
       *  admin's name; the customer's thread stays here. `departmentId` is one of the PLATFORM's queues. */
      escalate: (id: string, data: { departmentId: string; note?: string }) =>
        post<{ ticket: Ticket; escalation: Ticket }>(`/api/admin/tickets/${id}/escalate`, data),
      update: (
        id: string,
        data: {
          status?: TicketStatus;
          priority?: TicketPriority;
          assignedToId?: string | null;
          departmentId?: string;
          subject?: string;
          /** Why it's being handed over — goes with the mail and notification,
           *  and stays on the ticket as a line only handlers can see. */
          note?: string;
        },
      ) => patch<UpdatedTicket>(`/api/admin/tickets/${id}`, data),
      remove: (id: string) => del<{ ok: true }>(`/api/admin/tickets/${id}`),
      /** Fold `sourceId` into `id`: its messages move over and it is deleted.
       *  Same requester only. */
      merge: (id: string, sourceId: string) =>
        post<Ticket>(`/api/admin/tickets/${id}/merge`, { sourceId }),
      /** Accounts a request can be raised FOR — this lane's requesters. */
      requesters: (q = "") =>
        get<TicketRequesterOption[]>(`/api/admin/tickets/requesters${toQuery({ q })}`),
      agents: (departmentId?: string) =>
        get<TicketAgent[]>(
          `/api/admin/tickets/agents${departmentId ? `?departmentId=${encodeURIComponent(departmentId)}` : ""}`,
        ),
      uploadPolicy: () => get<TicketUploadPolicy>("/api/admin/tickets/upload-policy"),
      upload: (file: File, onProgress?: (p: number) => void, signal?: AbortSignal) =>
        uploadWithProgress<AttachmentDescriptor>("/api/admin/tickets/uploads", file, {
          onProgress,
          signal,
        }),
      savedReplies: {
        list: () => get<TicketSavedReply[]>("/api/admin/tickets/saved-replies"),
        create: (data: { title: string; body: string; departmentId: string | null }) =>
          post<TicketSavedReply>("/api/admin/tickets/saved-replies", data),
        update: (
          id: string,
          data: Partial<{ title: string; body: string; departmentId: string | null }>,
        ) => patch<TicketSavedReply>(`/api/admin/tickets/saved-replies/${id}`, data),
        remove: (id: string) => del<{ ok: true }>(`/api/admin/tickets/saved-replies/${id}`),
      },
      departments: {
        /** `scope: "all"` returns every queue in the lane (tagged `mine`); the reassign picker needs teams you don't work yourself. */
        list: (scope: "mine" | "all" = "mine") =>
          get<AdminTicketDepartment[]>(
            `/api/admin/tickets/departments${scope === "all" ? "?scope=all" : ""}`,
          ),
        create: (data: {
          name: string;
          description?: string;
          requesterVisible?: boolean;
          enabled?: boolean;
          order?: number;
          staffIds?: string[];
        }) => post<AdminTicketDepartment>("/api/admin/tickets/departments", data),
        update: (
          id: string,
          data: {
            name?: string;
            description?: string;
            requesterVisible?: boolean;
            enabled?: boolean;
            order?: number;
            /** Omit to leave membership alone; send the full list to replace it. */
            staffIds?: string[];
          },
        ) => patch<AdminTicketDepartment>(`/api/admin/tickets/departments/${id}`, data),
        remove: (id: string) => del<{ ok: true }>(`/api/admin/tickets/departments/${id}`),
      },
    },

    /* ----------------------------- API Center ------------------------- */
    /** `snapshot` is deliberately one fat call: six screens view the same provider rows, and fetching
     *  per-screen would show six slightly different moments in time. */
    apiCenter: {
      snapshot: (range: RangeKey = "24h", environment = "all") =>
        get<ApiCenterSnapshot>(
          `/api/admin/api-center/snapshot?range=${range}&environment=${encodeURIComponent(environment)}`,
        ),
      registry: () => get<ApiCenterRegistry>("/api/admin/api-center/registry"),
      provider: (id: string, range: RangeKey = "24h") =>
        get<ProviderDetail>(`/api/admin/api-center/providers/${encodeURIComponent(id)}?range=${range}`),
      refreshStatus: (id: string) =>
        post<ProviderStatusPayload>(`/api/admin/api-center/providers/${encodeURIComponent(id)}/refresh-status`),

      settings: () => get<ProviderSettingRow[]>("/api/admin/api-center/settings"),
      saveSettings: (
        provider: string,
        data: {
          monthlyQuota?: number;
          unitCostUsd?: number | null;
          rateLimitPerMin?: number;
          environment?: "production" | "sandbox";
          keyExpiresAt?: string | null;
          muted?: boolean;
          notes?: string;
        },
      ) => put<ProviderSettingRow>(`/api/admin/api-center/settings/${encodeURIComponent(provider)}`, data),

      keys: () => get<ApiKeyRow[]>("/api/admin/api-center/keys"),
      incidents: () => get<ProviderStatusPayload[]>("/api/admin/api-center/incidents"),

      logs: (params: ApiLogFilters = {}) =>
        get<ApiLogPage>(`/api/admin/api-center/logs${apiLogQuery(params)}`),
      /** Absolute URL so the browser can download it directly (auth via token in
       *  the header isn't possible on a plain link — see logsCsv usage). */
      logsCsvPath: (params: ApiLogFilters = {}) => `/api/admin/api-center/logs.csv${apiLogQuery(params)}`,

      errors: (range: RangeKey = "24h", provider = "all") =>
        get<{ range: RangeKey; groups: ErrorGroup[] }>(
          `/api/admin/api-center/errors?range=${range}&provider=${encodeURIComponent(provider)}`,
        ),

      alerts: (status: "open" | "all" = "open") =>
        get<AlertsResponse>(`/api/admin/api-center/alerts?status=${status}`),
      createRule: (data: {
        provider?: string | null;
        metric: AlertMetric;
        comparator?: "gt" | "lt";
        threshold: number;
        windowMin?: number;
        severity?: "warning" | "critical";
        enabled?: boolean;
        cooldownMin?: number;
      }) => post<AlertRule[]>("/api/admin/api-center/alerts/rules", data),
      updateRule: (
        id: string,
        data: Partial<{
          provider: string | null;
          metric: AlertMetric;
          comparator: "gt" | "lt";
          threshold: number;
          windowMin: number;
          severity: "warning" | "critical";
          enabled: boolean;
          cooldownMin: number;
        }>,
      ) => patch<AlertRule[]>(`/api/admin/api-center/alerts/rules/${id}`, data),
      deleteRule: (id: string) => del<AlertRule[]>(`/api/admin/api-center/alerts/rules/${id}`),
      acknowledgeAlert: (id: string) => post<AlertEvent[]>(`/api/admin/api-center/alerts/${id}/acknowledge`),
      resolveAlert: (id: string) => post<AlertEvent[]>(`/api/admin/api-center/alerts/${id}/resolve`),
    },
  },
  reseller: {
    overview: () => get<ResellerOverview>("/api/reseller/overview"),
    customerDetail: (id: string) =>
      get<ResellerCustomerDetail>(`/api/reseller/customers/${id}`),
  },
};

export type PhoneNumberStatus = "active" | "pending" | "inactive";

export interface PhonePoolNumber {
  id: string;
  number: string;
  status: PhoneNumberStatus;
  poolStatus: string; // AVAILABLE | ASSIGNED | PENDING_APPROVAL
  purchasePriceCents: number;
  monthlyPriceCents: number;
  addedAt: string;
  /** Tenant holding this number; null = the shared platform pool every brand's
   *  customers draw from at signup. */
  brandId: string | null;
  /** That tenant's name, for the super admin's brand column. Null when shared. */
  brandName: string | null;
  /** When an unassigned brand number returns to the shared pool (null = not counting down). Shown so a brand isn't surprised. */
  reclaimAt: string | null;
}
export interface PhoneUserNumber extends PhonePoolNumber {
  agentName: string;
  agentProvider: string;
  agentId: string | null;
  userEmail: string;
}
export interface PhoneOverview {
  pool: PhonePoolNumber[];
  userNumbers: PhoneUserNumber[];
  smsSender: string | null;
}
export interface PhoneAgent {
  id: string;
  name: string;
  provider: string;
  userEmail: string;
  autoRoutes: boolean;
  /** The brand whose database holds this agent — sent back when a number is routed to it. */
  brandId: string;
}
export interface PhoneImportable {
  sid: string;
  number: string;
  monthlyPriceCents: number;
}
export interface PhoneResync {
  configured: boolean;
  purged: number;
  owned: number;
  inPool: number;
  missing: number;
  assignmentsSynced: number;
}
export interface PhoneReplenishConfig {
  target: number;
  autoPurchase: boolean;
  country: string;
  /** Let customers buy a brand-new number during setup. */
  userPurchase: boolean;
  /** ISO codes of countries customers may pick a number from during setup. */
  allowedCountries: string[];
  /** Per-country national prefixes customers may pick (iso → prefix[]). */
  allowedPrefixes: Record<string, string[]>;
  /** Days a released number stays held in its brand's pool before returning to
   *  the shared platform pool. 0 = straight back. */
}
export interface PhoneReplenishResult {
  target: number;
  before: number;
  imported: number;
  purchased: number;
  available: number;
  autoPurchase: boolean;
  skipped?: string;
}

export interface StaffMember {
  id: string;
  email: string;
  fullName: string;
  permissions: string[];
  createdAt: string;
  /** Assigned role (RBAC). Null when the member has custom/no permissions. */
  roleId: string | null;
  roleName: string | null;
  /** Support queues granted to this person directly — editable on their page. */
  departments: { id: string; name: string }[];
  /** Inherited from their role. Read-only on the staff form; edit the role. */
  roleDepartments: { id: string; name: string }[];
}

/** A table column that can be individually gated within a section. */
export interface FieldDef {
  key: string;
  label: string;
}

export interface SectionDef {
  key: string;
  label: string;
  capabilities: string[];
  /** Column-level sub-permissions for this section's data table. */
  fields?: FieldDef[];
}

export interface CapabilityDef {
  key: string;
  label: string;
}

export interface PermissionsConfig {
  sections: SectionDef[];
  capabilities: CapabilityDef[];
}

export interface StaffRole {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  memberCount: number;
  /** Support queues this role works — the second half of ticket access. */
  departments: { id: string; name: string }[];
  createdAt: string;
}

export interface Reseller {
  id: string;
  email: string;
  fullName: string;
  referralCode: string | null;
  commissionPercent: number;
  referredCount: number;
  createdAt: string;
  earnedCents: number;
  pendingCents: number;
}

export interface ResellerOverview {
  referralCode: string | null;
  commissionPercent: number;
  referredCount: number;
  earnedCents: number;
  pendingCents: number;
  customers: {
    id: string;
    name: string;
    plan: "free" | "premium";
    subscriptionStatus: string;
    joinedAt: string;
    commissionCents: number;
  }[];
}

/** Full detail for one referred customer (contact + subscription + this
 *  reseller's commission history). No operational/payment internals. */
export interface ResellerCustomerDetail {
  id: string;
  name: string;
  fullName: string;
  email: string;
  businessName: string;
  mobile: string;
  website: string;
  businessNumber: string;
  plan: "free" | "premium";
  subscriptionStatus: string;
  joinedAt: string;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  autoRenew: boolean;
  commission: { totalCents: number; paidCents: number; pendingCents: number };
  commissionHistory: {
    amountCents: number;
    percent: number;
    invoiceAmountCents: number;
    status: string;
    createdAt: string;
  }[];
}

export type BillingInterval = "week" | "month" | "year";

// Inferred from the shared Zod schemas in @shared/contracts/voices; re-exported
// under the old names so nothing else has to change its imports.
export type VoiceCatalogItem = SharedVoiceCatalogItem;
export type VoiceCatalogItemWithProvider = SharedVoiceCatalogItem;
export type VoiceCatalogResponse = SharedVoiceCatalogResponse;
export type ProviderVoice = SharedProviderVoice;
export type AllVoicesResponse = SharedAllVoicesResponse;

/** A Voice Bank category (admin-curated named set of voices, both providers). */
export interface VoiceCategory {
  id: string;
  title: string;
  voiceIds: string[];
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionPlan {
  id: string;
  name: string;
  displayName: string;
  description: string;
  priceCents: number;
  currency: string;
  interval: BillingInterval;
  /** Units per cycle: 1 = monthly, 3 = quarterly, 12 = annual. */
  intervalCount: number;
  includedMinutes: number;
  features: string[];
  smsEnabled: boolean;
  /** "SMS to Caller" — the AI texts callers details they ask for mid-call. */
  smsToCallerEnabled: boolean;
  whatsappEnabled: boolean;
  /** Custom CRM (webhook) lead delivery is included in this plan. */
  customCrmEnabled: boolean;
  /** The assistant may answer in the caller's language (languages picked in the AI Brain). */
  multilingualEnabled: boolean;
  /** "Summary, Transcript & Recording" bullet is advertised for this plan. */
  transcriptsEnabled: boolean;
  /** Human Call Transfer is included in this plan. */
  callTransferEnabled: boolean;
  /** Max transfer departments; 0 = unlimited. Only meaningful while enabled. */
  callTransferLimit: number;
  allowedVoices: string[]; // deprecated
  /** Voice Bank category this plan unlocks (null = customers stay on the default voice). */
  voiceCategoryId: string | null;
  /** Display name of the unlocked voice category (e.g. "Basic"/"Premium"), resolved
   *  by the public /billing/plans endpoint so the subscribe page can show a voice pill. */
  voiceCategoryName?: string | null;
  stripeProductId: string | null;
  stripePriceId: string | null;
  active: boolean;
  sortOrder: number;
  recommended: boolean;
  /** Pre-selected plan on the onboarding subscribe page (at most one is default). */
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  /** Admin list only: live subscribers + legacy flag (deactivated but still in use). */
  subscriberCount?: number;
  legacy?: boolean;
}

export interface SubscriptionDetail {
  status: string;
  planId: string | null;
  planName: string | null;
  priceCents: number;
  currency: string;
  interval: string;
  intervalCount: number;
  includedMinutes: number;
  smsEnabled: boolean;
  smsToCallerEnabled: boolean;
  whatsappEnabled: boolean;
  customCrmEnabled: boolean;
  multilingualEnabled: boolean;
  callTransferEnabled: boolean;
  callTransferLimit: number;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  autoRenew: boolean;
  legacy: boolean;
  scheduledPlan: { id: string; name: string; effectiveAt: string | null } | null;
  /** The coupon discount running on this account, or null. */
  discount: ActiveDiscount | null;
}

/** A coupon discount currently applied to the signed-in user's subscription. */
export interface ActiveDiscount {
  code: string;
  displayName: string;
  percentOff: number | null;
  bonusMinutes: number | null;
  cyclesUsed: number;
  durationCycles: number;
  cyclesLeft: number;
}

/** Result of checking a coupon code at checkout. Invalid results carry only a
 *  deliberately vague message — the endpoint must not confirm which codes exist. */
export type CouponValidation =
  | { valid: false; message: string }
  | {
      valid: true;
      code: string;
      displayName: string;
      description: string;
      percentOff: number | null;
      bonusMinutes: number | null;
      durationCycles: number;
      discountCents: number;
      newTotalCents: number;
      currency: string;
    };

/** Admin view of a coupon, with its live redemption counts. */
export interface Coupon {
  id: string;
  code: string;
  displayName: string;
  description: string;
  percentOff: number | null;
  bonusMinutes: number | null;
  durationCycles: number;
  startsAt: string | null;
  expiresAt: string | null;
  maxRedemptions: number | null;
  redeemedCount: number;
  newCustomersOnly: boolean;
  planIds: string[];
  active: boolean;
  stripeCouponId: string | null;
  createdAt: string;
  activeRedemptions: number;
  totalRedemptions: number;
  /** Checkouts holding a live reservation right now. */
  livePending: number;
  /** Terms frozen — someone has redeemed it, or is checking out with it. */
  locked: boolean;
  soldOut: boolean;
}

export interface CouponInput {
  code: string;
  displayName: string;
  description?: string;
  percentOff?: number | null;
  bonusMinutes?: number | null;
  durationCycles?: number;
  startsAt?: string | null;
  expiresAt?: string | null;
  maxRedemptions?: number | null;
  newCustomersOnly?: boolean;
  planIds?: string[];
  active?: boolean;
}

/** One row in the admin's "grant a coupon" picker, with eligibility resolved
 *  server-side so the button and the rule can't disagree. */
export interface GrantableCoupon {
  id: string;
  code: string;
  displayName: string;
  percentOff: number | null;
  bonusMinutes: number | null;
  durationCycles: number;
  eligible: boolean;
  /** Why it can't be granted (present only when `eligible` is false). */
  reason: string | null;
  /** Grantable, but the admin should know something first. */
  warning: string | null;
  /** Breaks a rule an admin may step past (expired / not started / wrong plan)
   *  — the grant needs an explicit override. */
  requiresOverride: boolean;
  restrictions: ("expired" | "not_started" | "plan_not_eligible")[];
  /** The window date being stepped past (ISO), for the confirmation copy. */
  windowEndsAt: string | null;
}

/** What the customer's Discount card renders. */
export interface CustomerDiscount {
  code: string;
  displayName: string;
  percentOff: number | null;
  bonusMinutes: number | null;
  cyclesUsed: number;
  durationCycles: number;
  cyclesLeft: number;
  grantedByAdmin: boolean;
  appliedAt: string | null;
}

export interface CustomerCouponState {
  discount: CustomerDiscount | null;
  coupons: GrantableCoupon[];
}

export interface CouponRedemptionRow {
  id: string;
  status: "pending" | "active" | "exhausted" | "revoked";
  cyclesUsed: number;
  reservedAt: string;
  appliedAt: string | null;
  endedAt: string | null;
  grantedBy: string | null;
  user: { id: string; email: string; fullName: string };
}

export interface PlanChangePreview {
  direction: "upgrade" | "downgrade" | "same";
  isTrial: boolean;
  currentPlan: { id: string; name: string; priceCents: number };
  newPlan: { id: string; name: string; priceCents: number; includedMinutes: number };
  minutesAllocated: number;
  minutesRemaining: number;
  creditCents: number;
  amountDueCents: number;
  currency: string;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  /** Name of a pending downgrade this change would replace/cancel, if any. */
  replacesScheduledPlanName: string | null;
  effectiveAt: string | null;
}

export interface Invoice {
  id: string;
  number: string | null;
  status: string | null;
  amountDue: number;
  amountPaid: number;
  currency: string;
  created: number;
  hostedInvoiceUrl: string | null;
  pdfUrl: string | null;
}

export interface PlanInput {
  name: string;
  displayName: string;
  description?: string;
  priceCents: number;
  currency?: string;
  interval?: BillingInterval;
  intervalCount?: number;
  includedMinutes?: number;
  smsEnabled?: boolean;
  smsToCallerEnabled?: boolean;
  whatsappEnabled?: boolean;
  customCrmEnabled?: boolean;
  multilingualEnabled?: boolean;
  transcriptsEnabled?: boolean;
  callTransferEnabled?: boolean;
  callTransferLimit?: number;
  allowedVoices?: string[];
  voiceCategoryId?: string | null;
  sortOrder?: number;
  recommended?: boolean;
  isDefault?: boolean;
  features?: string[];
  active?: boolean;
}

export interface IntegrationField {
  key: string;
  label: string;
  secret: boolean;
  isSet: boolean;
  value: string; // masked for secrets, full for non-secrets
}

export interface IntegrationView {
  id: string;
  name: string;
  description: string;
  /** Admin saved the required keys in the DB. */
  connected: boolean;
  fields: IntegrationField[];
}

/** One selectable LLM in the admin "Default Agent Model" dropdown. */
export interface AgentLlmOption {
  provider: string;
  model: string;
  label: string;
  providerLabel: string;
  /** Vapi's estimated cost/min (USD) & latency (ms) — null when Vapi has no estimate. */
  costPerMin: number | null;
  latencyMs: number | null;
}

/** Response of the admin default-agent-LLM endpoint: the current selection plus
 *  the catalogue to choose from and the built-in default. */
export interface AgentLlmSettings {
  provider: string;
  model: string;
  options: AgentLlmOption[];
  default: { provider: string; model: string };
}

/** One selectable transcriber provider in the admin fallback dropdown. */
export interface TranscriberOption {
  provider: string;
  label: string;
  models: string[];
  /** Tiers the provider can transcribe ("en" | "multi" | "wide"). */
  tiers: string[];
}

/** Response of the admin transcriber-fallback endpoint: the saved preference plus
 *  the provider/model catalogue to choose from. */
export interface TranscriberFallbackSettings {
  autoFallback: boolean;
  provider: string;
  model: string;
  options: TranscriberOption[];
}

export type BrandingSlot =
  | "logoLight"
  | "logoDark"
  | "favicon"
  | "avatarFemale"
  | "avatarMale";
export type Branding = Record<BrandingSlot, string>;
export interface BrandingState {
  storageConfigured: boolean;
  assets: Branding;
}

export interface AdminOverview {
  /** Real end-users (role USER) — never counts admins/staff/resellers. */
  customers: number;
  /** Customers who signed up in the last 30 days. */
  newCustomers: number;
  /** Customers currently in a free trial (not yet billed). */
  trialing: number;
  /** Truly paying subscribers (subscriptionStatus active | past_due). */
  paying: number;
  /** Real monthly recurring revenue, derived from each paying plan's price and
   *  normalised to `mrrCurrency` — plans exist in more than one currency. */
  mrr: number;
  /** Currency `mrr` is expressed in (the reporting base, "usd"). */
  mrrCurrency: string;
  /** A live plan uses a currency with no configured rate, so it was counted
   *  unconverted — the figure needs a rate before it can be trusted. */
  mrrUnconvertible: boolean;
  totalCalls: number;
  /** Real metered minutes consumed (free-trial + paid-plan), not call-log durations. */
  totalMinutes: number;
  trialMinutes: number;
  planMinutes: number;
  phones: { total: number; assigned: number; available: number };
  resellers: number;
  /** Unpaid reseller commission owed, in whole currency units. */
  pendingCommission: number;
  staff: number;
  admins: number;
  /** Distribution of live customers across their actual plans (legacy flagged). */
  planMix: { id: string | null; name: string; subscribers: number; legacy: boolean }[];
  recentSignups: {
    id: string;
    email: string;
    fullName: string;
    plan: "free" | "premium";
    planName: string | null;
    status: string;
    createdAt: string;
  }[];
}

export interface Customer {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  businessName: string;
  plan: "free" | "premium";
  numberActivated: boolean;
  /** Real subscription state (source of truth for plan name + status). */
  subscriptionStatus: string; // none | trialing | active | past_due | canceled | suspended
  /** Derived: verified account that never FINISHED onboarding (no plan, no
   *  card-less trial yet). Not a stored status — computed from lifecycle state. */
  onboarding: boolean;
  /** Derived: completed onboarding, no paid plan, still inside the card-less free
   *  trial (subscriptionStatus stays "none" for them). Drives the Trial badge. */
  freeTrial: boolean;
  /** True only for an admin account lock (vs a grace-lapsed billing suspension). */
  suspended: boolean;
  planName: string | null;
  planPriceCents: number;
  planInterval: string;
  /** Live Vapi assistant id (links to the Vapi dashboard), null if not provisioned. */
  vapiAssistantId: string | null;
  callCount: number;
  createdAt: string;
  /** When the customer opted out of notification emails (null = still subscribed). */
  emailOptOutAt: string | null;
  /** Live presence (active SSE stream). Point-in-time only: resets on API restart, says nothing about last seen. */
  online: boolean;
}

/* ---------------------- Admin → Subscriptions ---------------------- */

/** A customer's plan as shown in Admin → Subscriptions (legacy = deactivated). */
export interface AdminSubscriptionPlanRef {
  id: string;
  name: string;
  priceCents: number;
  currency: string;
  interval: string;
  intervalCount: number;
  legacy: boolean;
}

/** Pending scheduled downgrade — the plan they'll move to at period end. */
export interface AdminScheduledPlan {
  id: string;
  name: string;
  effectiveAt: string | null;
}

export interface AdminSubscriptionRow {
  userId: string;
  fullName: string;
  email: string;
  /** Contact mobile from the profile ("" when not captured). */
  phone: string;
  businessName: string;
  /** Account creation date — when this lead registered. */
  signupAt: string;
  /** Registered but never subscribed — onboarding drop-off / no plan picked. */
  underOnboarding: boolean;
  /** Pending funnel step (5=Services, 6=Voice, 7=Finish, 8=Pricing); 0 = done or direct signup. */
  onboardingStep: number;
  onboardingCompletedAt: string | null;
  plan: AdminSubscriptionPlanRef | null;
  /** none | trialing | active | past_due | canceled | suspended (admin lock wins). */
  status: string;
  autoRenew: boolean;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  scheduledPlan: AdminScheduledPlan | null;
  /** Current-phase usage: trial counters while trialing, plan counters otherwise. */
  minutesUsed: number;
  minutesAllocated: number;
  /** This row's monthly-normalised MRR contribution (0 unless active/past_due). */
  mrrCents: number;
}

export interface AdminSubscriptionsSummary {
  total: number;
  active: number;
  trialing: number;
  pastDue: number;
  /** Registered but never subscribed — the "Under onboarding" call list. */
  onboarding: number;
  /** Canceled + suspended — had a subscription and lost it (excludes onboarding leads). */
  canceled: number;
  /** Summed across every paying row and normalised to `mrrCurrency`. */
  mrrCents: number;
  /** Currency `mrrCents` is expressed in (the reporting base, "usd"). */
  mrrCurrency: string;
}

export interface AdminSubscriptionsResponse {
  summary: AdminSubscriptionsSummary;
  subscriptions: AdminSubscriptionRow[];
}

export type PlanEventType =
  | "trial_started"
  | "trial_converted"
  | "upgraded"
  | "downgrade_scheduled"
  | "downgraded"
  | "downgrade_canceled"
  | "plan_switched"
  | "renewed"
  | "canceled"
  | "auto_renew_off"
  | "auto_renew_on"
  | "coupon_applied"
  | "coupon_expired"
  | "coupon_reattached";

/** One plan-history timeline entry (plan names denormalized at write time). */
export interface PlanEvent {
  id: string;
  type: PlanEventType;
  fromPlanId: string | null;
  fromPlanName: string | null;
  toPlanId: string | null;
  toPlanName: string | null;
  priceCents: number;
  currency: string;
  /** Money actually charged for this event (0 for free transitions). */
  amountCents: number;
  note: string;
  createdAt: string;
}

export interface AdminSubscriptionDetail {
  customer: {
    id: string;
    fullName: string;
    email: string;
    phone: string;
    businessName: string;
    createdAt: string;
  };
  subscription: {
    status: string;
    underOnboarding: boolean;
    onboardingStep: number;
    plan: AdminSubscriptionPlanRef | null;
    autoRenew: boolean;
    trialEndsAt: string | null;
    currentPeriodEnd: string | null;
    scheduledPlan: AdminScheduledPlan | null;
    stripeCustomerId: string | null;
    minutesUsed: number;
    minutesAllocated: number;
  };
  history: PlanEvent[];
  invoices: Invoice[];
}

export interface AuditLogEntry {
  id: string;
  actorId: string | null;
  /** The brand the actor belongs to; null for the platform's own people. */
  actorBrandId: string | null;
  /** Named for the platform's own audit page; empty for a brand admin's own trail. */
  actorBrandName?: string;
  actorEmail: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: unknown;
  ip: string;
  createdAt: string;
}

export interface AuditLogPage {
  rows: AuditLogEntry[];
  total: number;
  page: number;
  pageSize: number;
  actions: string[];
}

export type WebhookDeliveryStatus = "all" | "success" | "failed";

export interface WebhookDeliveryLog {
  id: string;
  provider: string;
  url: string;
  status: number;
  success: boolean;
  responseBody: string;
  errorMessage: string;
  durationMs: number;
  callLogId: string | null;
  createdAt: string;
}

export interface SystemHealth {
  integrations: Record<string, boolean>;
  webhooks: {
    total: number;
    success: number;
    failed: number;
    successRate: number;
    avgLatencyMs: number;
    last24h: number;
  };
  counts: {
    totalUsers: number;
    totalCalls: number;
    callsLast24h: number;
    pendingApprovals: number;
  };
  recentErrors: {
    provider: string;
    errorMessage: string;
    status: number;
    createdAt: string;
  }[];
}

export interface CustomerDetail {
  customer: {
    id: string;
    email: string;
    fullName: string;
    role: UserRole;
    businessName: string;
    plan: "free" | "premium";
    numberActivated: boolean;
    mobile: string;
    website: string;
    subscriptionStatus: string;
    trialEndsAt: string | null;
    receptionistNumber: string;
    createdAt: string;
  };
  agent: {
    name: string;
    status: string;
    vapiAssistantId: string | null;
    agentConfig: AgentConfig;
  } | null;
  calls: {
    id: string;
    /** "Web" = a browser test call, "Phone" = a real inbound call. */
    type: "Web" | "Phone";
    callerName: string;
    callerNumber: string;
    outcome: string;
    durationSec: number;
    createdAt: string;
  }[];
  usage: { callsHandled: number; minutesUsed: number };
  billing: {
    plan: "free" | "premium";
    /** The subscribed plan's display name ("Standard"), or null when there's no
     *  plan. Preferred over `plan`, which reads "free" during a paid-plan trial. */
    planName: string | null;
    subscriptionStatus: string;
    /** Derived: verified account that never FINISHED onboarding. */
    onboarding: boolean;
    /** Derived: completed onboarding, no plan, still on the card-less free trial. */
    freeTrial: boolean;
    /** True only for an admin account lock (vs a grace-lapsed billing suspension). */
    suspended: boolean;
    stripeCustomerId: string | null;
    trialEndsAt: string | null;
    /** The onboarding rule at THIS account's creation; the admin toggle never affects existing accounts. */
    cardRequiredAtSignup: boolean;
    /** When their first card landed; null = never. With the flag above, identifies
     *  a customer still stuck at the card wall. */
    cardConfirmedAt: string | null;
  };
}

export interface UserDigest {
  subject: string;
  html: string;
  stats: {
    callsHandled: number;
    leadsCaptured: number;
    minutesUsed: number;
    missed: number;
    topIntents: { intent: string; count: number }[];
  };
}
