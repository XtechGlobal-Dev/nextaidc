import type { SubscriptionPlan } from "@/lib/api";

/** Fixed, ordered feature rows for a plan card, derived from the plan's toggles (no free-text list).
 *  Excluded rows stay greyed out in position so the cards line up row-for-row; new bullets need a new slot here. */
export interface PlanFeatureRow {
  label: string;
  /** true → shown with a ✓; false → greyed-out with a ✗ (capability not in this plan). */
  included: boolean;
}

/** Cache of the last plan-entitlement response, read synchronously so gated UI doesn't flash on first paint. */
export const ENTITLEMENTS_CACHE_KEY = "hello22_summary_channels";

/** SMS to Caller included? Falls back to the older `sms` flag (missing during a frontend-ahead-of-API deploy),
 *  and to true when nothing is cached, so a first paint never shows a false "not in your plan". */
/** Clear cached entitlements after a payment/plan switch/cancel; the next read falls back to "included"
 *  and the screen refetches on mount anyway, which beats writing a guess. */
export function clearCachedEntitlements(): void {
  try {
    localStorage.removeItem(ENTITLEMENTS_CACHE_KEY);
  } catch {
    /* ignore unavailable storage */
  }
}

export function cachedSmsToCallerEntitlement(): boolean {
  try {
    const raw = localStorage.getItem(ENTITLEMENTS_CACHE_KEY);
    if (!raw) return true;
    const c = JSON.parse(raw) as { smsToCaller?: boolean; sms?: boolean };
    return Boolean(c.smsToCaller ?? c.sms ?? true);
  } catch {
    return true;
  }
}

/** Call Transfer bullet label. `callTransferLimit` is 0 for both "unlimited" and "off", so check the flag first. */
export function callTransferLabel(plan: {
  callTransferEnabled?: boolean;
  callTransferLimit?: number;
}): string {
  if (!plan.callTransferEnabled) return "Call Transfer";
  const limit = plan.callTransferLimit ?? 0;
  if (limit <= 0) return "Unlimited Call Transfer";
  return `Call Transfer (up to ${limit} department${limit === 1 ? "" : "s"})`;
}

/** Cached transfer-department allowance; 0 = not included. Defaults to unlocked when nothing is cached
 *  so a first paint never flashes a false "not in your plan". */
export function cachedCallTransferDepartments(): number {
  try {
    const raw = localStorage.getItem(ENTITLEMENTS_CACHE_KEY);
    if (!raw) return Number.POSITIVE_INFINITY;
    const c = JSON.parse(raw) as { callTransferDepartments?: number };
    return typeof c.callTransferDepartments === "number"
      ? c.callTransferDepartments
      : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Only the fields the row builder needs — works with any plan-shaped object. */
export type PlanFeatureSource = Pick<
  SubscriptionPlan,
  | "smsEnabled"
  | "smsToCallerEnabled"
  | "whatsappEnabled"
  | "customCrmEnabled"
  | "multilingualEnabled"
  | "transcriptsEnabled"
  | "callTransferEnabled"
  | "callTransferLimit"
  | "voiceCategoryName"
>;

export interface PlanFeatureOptions {
  /** Resolved voice-category title; the admin list endpoint doesn't embed it. Falls back to `plan.voiceCategoryName`, then "Basic". */
  voiceCategoryName?: string | null;
}

/** Canonical fixed-order feature rows for a plan card; the order is shared across pages, don't reorder per page. */
export function buildPlanFeatureRows(
  plan: PlanFeatureSource,
  opts: PlanFeatureOptions = {},
): PlanFeatureRow[] {
  // Name may be a full label or just a tier word; only append "AI Voices" when
  // it isn't one already, or we render "Premium AI Voices AI Voices".
  const voiceName = (opts.voiceCategoryName ?? plan.voiceCategoryName ?? "").trim();
  const voiceLabel = !voiceName
    ? "Basic AI Voices"
    : /voice/i.test(voiceName)
      ? voiceName
      : `${voiceName} AI Voices`;

  return [
    // Either/or slots — always shown with a ✓, label flips with the plan's setting.
    {
      label: plan.multilingualEnabled ? "Multilingual Answering" : "English Only",
      included: true,
    },
    { label: voiceLabel, included: true },
    // On/off slots — ✓ when enabled, greyed-out ✗ when not (kept in place for alignment).
    { label: "Summary, Transcript & Recording", included: Boolean(plan.transcriptsEnabled) },
    { label: "WhatsApp Summaries + Auto-Reply", included: Boolean(plan.whatsappEnabled) },
    { label: "Post-Call SMS Summaries", included: Boolean(plan.smsEnabled) },
    // Distinct from the row above: that texts the OWNER a summary after the call,
    // this lets the AI text the CALLER details they ask for during it.
    { label: "SMS to Caller", included: Boolean(plan.smsToCallerEnabled) },
    // Allowance goes in the label: plain "Call Transfer" hides the 3-vs-unlimited difference buyers compare.
    { label: callTransferLabel(plan), included: Boolean(plan.callTransferEnabled) },
    // Nexleon setup is free on every plan; Custom CRM integration is the upgrade on top.
    { label: "Free Nexleon CRM Setup", included: true },
    { label: "Custom CRM Integration", included: Boolean(plan.customCrmEnabled) },
  ];
}
