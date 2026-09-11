import type { SubscriptionPlan } from "@/lib/api";

/**
 * Single source of truth for the ordered feature rows shown on a plan card.
 *
 * Every feature bullet is DERIVED from the plan's structured fields (toggles + voice
 * category) — there is no free-text feature list anymore. Because the slots are a fixed,
 * ordered set, the same rows appear in the same order on every plan and every page
 * (onboarding subscribe, logged-in billing, admin preview). Rows the plan doesn't include
 * are shown greyed-out with a ✗ *in their fixed position* — they never sink or reshuffle —
 * so the three plan cards line up row-for-row for easy comparison.
 *
 * To add a new feature bullet, add a slot here (and a backing field/toggle) — that is the
 * intentional trade-off for guaranteed-consistent ordering.
 */
export interface PlanFeatureRow {
  label: string;
  /** true → shown with a ✓; false → greyed-out with a ✗ (capability not in this plan). */
  included: boolean;
}

/** Shared cache of the plan-entitlement response, written by whichever screen
 *  fetched it last. Read synchronously so gated UI (the SMS to Caller nav badge,
 *  its locked state) renders correctly on first paint instead of flashing. */
export const ENTITLEMENTS_CACHE_KEY = "hello22_summary_channels";

/** Is "SMS to Caller" included, per the last known entitlement response?
 *
 *  Falls back to the older `sms` flag when `smsToCaller` is absent: the two used
 *  to share one flag, so during a deploy where the frontend is newer than the API
 *  the field is simply missing — reading that as `false` would lock the feature
 *  for everyone who actually has it. Defaults to true when nothing is cached, so
 *  a first paint never shows a false "not in your plan". */
/**
 * Forget the cached entitlements after something that can change them — a
 * payment, a plan switch, a cancellation.
 *
 * Entitlements are now enforced from the moment a payment lands, so a stale
 * cache is the difference between the UI locking immediately and it staying
 * open until the user happens to load a screen that refetches. Clearing beats
 * writing a guess: the next read falls back to "included", and the screen that
 * needs it refetches on mount anyway.
 */
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

/**
 * Bullet label for the plan's Call Transfer allowance.
 *
 * `callTransferLimit` is 0 for BOTH "unlimited" and "irrelevant, it's off", so
 * the flag has to be read first — see transferDepartmentAllowance() server-side.
 */
export function callTransferLabel(plan: {
  callTransferEnabled?: boolean;
  callTransferLimit?: number;
}): string {
  if (!plan.callTransferEnabled) return "Call Transfer";
  const limit = plan.callTransferLimit ?? 0;
  if (limit <= 0) return "Unlimited Call Transfer";
  return `Call Transfer (up to ${limit} department${limit === 1 ? "" : "s"})`;
}

/** How many transfer departments the plan allows, per the last known entitlement
 *  response; 0 = Call Transfer isn't included. Defaults to unlocked when nothing
 *  is cached, for the same reason the SMS reader does: a first paint must never
 *  flash a false "not in your plan". */
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
  /**
   * Resolved voice-category title (e.g. "Basic" / "Premium"). The admin list endpoint
   * doesn't embed the name, so the admin page resolves it and passes it here. Falls back
   * to `plan.voiceCategoryName`, then to "Basic".
   */
  voiceCategoryName?: string | null;
}

/**
 * Build the canonical, fixed-order feature rows for a plan card.
 *
 * The order below is intentional and shared across all pages — do not reorder per page.
 */
export function buildPlanFeatureRows(
  plan: PlanFeatureSource,
  opts: PlanFeatureOptions = {},
): PlanFeatureRow[] {
  // The voice-category name may already be a full label ("Premium AI Voices") or just a
  // tier word ("Premium"). Only append "AI Voices" when it isn't already a voice label,
  // so we never render "Premium AI Voices AI Voices".
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
    // The allowance is part of the label rather than a separate row: "Call
    // Transfer" alone reads identically on a 3-department plan and an unlimited
    // one, which is exactly the difference a buyer is comparing.
    { label: callTransferLabel(plan), included: Boolean(plan.callTransferEnabled) },
    // Nexleon setup is free on every plan; Custom CRM integration is the upgrade on top.
    { label: "Free Nexleon CRM Setup", included: true },
    { label: "Custom CRM Integration", included: Boolean(plan.customCrmEnabled) },
  ];
}
