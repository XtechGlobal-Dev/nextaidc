export * from "./agent";
export * from "./call";
export * from "./booking";

/* Shared account / billing types */

export type PlanTier = "free" | "premium";

export interface Profile {
  id: string;
  fullName: string;
  businessName: string;
  email: string;
  mobile: string;
  website: string;
  /** Public support number customers call (distinct from the AI's receptionistNumber). */
  businessNumber: string;
  address: string;
  country: string;
  industry: string;
  plan: PlanTier;
  /** Trial usage (free plan = 10 minutes). */
  testMinutesUsed: number;
  webTestMinutesUsed: number;
  webTestCycleStart: string; // ISO
  receptionistNumber: string; // masked AI number
  numberActivated: boolean;
  /** Call forwarding: chosen behaviour ("" | "all" | "overflow") and when the
   *  owner confirmed forwarding from their existing number to the AI is live. */
  forwardingMode: "" | "all" | "overflow";
  forwardingConfirmedAt?: string | null;
  /** Guided-onboarding resume state. onboardingStep = pending step (5-8); 0 once done. */
  onboardingStep: number;
  onboardingCompletedAt?: string | null;
  /** First time the quick-setup modal was skipped/finished. Once set, it never
   *  auto-opens again (server-side, so it survives a cache clear / new browser). */
  quickSetupSeenAt?: string | null;
  // Billing / subscription (present in dynamic mode).
  subscriptionStatus?: string; // none | trialing | active | past_due | canceled | suspended
  subscriptionPlanId?: string | null;
  /** Whether a card was required when THIS account signed up (frozen at signup —
   *  the admin toggle is never re-read).
   *  ABSENT on a profile cached before this shipped, so read sites must test
   *  `=== true` — undefined has to mean grandfathered, never "wall them". */
  cardRequiredAtSignup?: boolean;
  /** When the first card was confirmed (ISO); null/absent = never. Paired with
   *  the flag above by `cardWallActive` — see src/lib/cardWall.ts for why the
   *  subscription status can't be used for this. */
  cardConfirmedAt?: string | null;
  trialEndsAt?: string | null;
  /** Set (ISO) when an admin has locked the account; null/absent otherwise. */
  suspendedAt?: string | null;
}

export type EntitlementPhase = "trial" | "active" | "none";
export type EntitlementStatus =
  | "active"
  | "expired_minutes"
  | "expired_date"
  | "past_due"
  | "no_subscription";

/** Trial-only status (subset of EntitlementStatus) used by badge helpers. */
export type TrialStatus = "active" | "expired_minutes" | "expired_date";

/** The signed-in user's live minute entitlement — trial OR paid plan. */
export interface TrialState {
  phase: EntitlementPhase;
  status: EntitlementStatus;
  isTrial: boolean;
  unlimited: boolean;
  minutesAllocated: number;
  minutesUsed: number;
  minutesRemaining: number;
  /** Same as minutesAllocated — the plan/trial allowance. */
  planMinutes: number;
  daysRemaining: number;
  /** Admin-configured total trial length (the "you get N days" allowance), not a countdown. */
  trialDays: number;
  trialEndsAt: string | null;
  periodEnd: string | null;
  blocked: boolean;
  /** Has a paid plan they can renew now (blocked active plan / past_due). */
  canRenew: boolean;
  /** Active plan auto-renews + auto-charges on exhaustion — a live call then runs
   *  into the next cycle instead of being cut at the remaining-minutes boundary. */
  autoRenew: boolean;
  planName: string | null;
  /** Post-trial grace: blocked, but the number is still held until graceEndsAt. */
  graceActive: boolean;
  graceEndsAt: string | null;
  graceDaysRemaining: number;
  /** Grace lapsed without renewal → account fully suspended (dashboard locked). */
  suspended: boolean;
  /** Admin locked the account (manual suspend). Hard-logs-out to /login; only an
   *  admin can lift it (distinct from the self-recoverable `suspended` above). */
  adminSuspended: boolean;
}

export type CrmProvider = "google_calendar" | "custom" | "movermate" | "perfex";

export interface CrmIntegration {
  connectedProvider: CrmProvider | null;
  googleCalendarConnected: boolean;
  customWebhookUrl: string;
  nexleonUrl: string | null;
  nexleonFormKey: string | null;
  /** Google Calendar booking settings. bookingEnabled is the master switch for
   *  AI booking + auto event creation; the rest configure the created event. */
  bookingEnabled: boolean;
  bookingDurationMin: number;
  bookingCalendarId: string;
  bookingTimezone: string;
  /** Admin-global Nexleon CRM (Admin → Settings) — the company default every
   *  user's leads fall back to unless they save their own. Read-only. */
  defaultNexleonUrl?: string | null;
  defaultNexleonFormKey?: string | null;
}

export interface EmailTemplate {
  key: string;
  category: string;
  name: string;
  description: string;
  audience: "User" | "Admin" | "Staff";
  subject: string;
  body: string;
  variables: string[];
  enabled: boolean;
  alwaysOn: boolean;
}

export interface EmailBranding {
  header: string;
  footer: string;
  fromName: string;
}

export interface WebhookDelivery {
  id: string;
  provider: string;
  url: string;
  status: number;
  success: boolean;
  errorMessage: string;
  durationMs: number;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/*  Human Call Transfer                                                 */
/* ------------------------------------------------------------------ */

export interface HumanTransferSettings {
  id: string;
  enabled: boolean;
  /** E.164 number the AI bridges the caller to. */
  transferNumber: string;
  /** How long the number rings before the AI speaks the end message. */
  ringTimeoutSec: number;
  /** Spoken by the AI when the transfer can't connect. */
  fallbackMessage: string;
}

/** A named transfer department: the AI asks which department the caller needs,
 *  then warm-transfers them to this number. */
export interface TransferDepartment {
  id: string;
  name: string;
  /** E.164 number the caller is transferred to for this department. */
  number: string;
  /** Optional hint that helps the AI route (e.g. "billing, refunds"). */
  description: string;
  enabled: boolean;
  /** How long this department's number rings before the AI speaks its end message. */
  ringTimeoutSec: number;
  /** Spoken by the AI when this department's transfer can't connect. */
  fallbackMessage: string;
  order: number;
}

export type ChatRole = "user" | "assistant" | "human";

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: ChatRole;
  content: string;
  createdAt: string; // ISO
}

export interface ChatConversation {
  id: string;
  humanTakeover: boolean;
  createdAt: string;
}
