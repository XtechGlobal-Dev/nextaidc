import type { Customer } from "@/lib/api";

// Customer lifecycle buckets. State is spread across `suspended`, `onboarding`/`freeTrial` and the raw
// `subscriptionStatus`; derived once here so the badge and the filter can't disagree about a row.

export type StatusKey =
  | "active"
  | "trial"
  | "past_due"
  | "no_plan"
  | "onboarding"
  | "canceled"
  | "suspended";

export type StatusVariant = "neutral" | "success" | "warning" | "danger";

export const STATUS_META: Record<
  StatusKey,
  { label: string; variant: StatusVariant; hint?: string }
> = {
  active: { label: "Active", variant: "success" },
  trial: { label: "Trial", variant: "warning" },
  past_due: { label: "Past due", variant: "danger" },
  // The "went quiet" bucket: finished signing up, used up (or ran out) the free
  // trial, and never bought a plan. This is what an admin means by a dead lead.
  no_plan: { label: "No plan", variant: "neutral", hint: "Trial over, never subscribed" },
  onboarding: { label: "Onboarding", variant: "warning", hint: "Signed up, never finished" },
  canceled: { label: "Canceled", variant: "neutral" },
  suspended: { label: "Suspended", variant: "danger" },
};

/** Display order for the filter — the states an admin looks for first. */
export const STATUS_ORDER: StatusKey[] = [
  "active",
  "trial",
  "no_plan",
  "onboarding",
  "past_due",
  "canceled",
  "suspended",
];

/** Lifecycle bucket. Order is deliberate: admin lock outranks billing state, and onboarding/free-trial
 *  outrank a raw "none" (both have `subscriptionStatus === "none"` but are nothing alike). */
export function statusKey(c: Customer): StatusKey {
  if (c.suspended) return "suspended";
  if (c.onboarding) return "onboarding";
  if (c.freeTrial) return "trial";
  switch (c.subscriptionStatus) {
    case "active":
      return "active";
    case "trialing":
      return "trial";
    case "past_due":
      return "past_due";
    case "suspended":
      return "suspended";
    case "canceled":
      return "canceled";
    default:
      return "no_plan";
  }
}

/** The plan a customer is on. Everyone without a paid subscription plan lands in
 *  one "Free" bucket, so the filter doesn't sprout a blank option. */
export function planLabel(c: Customer): string {
  return c.planName?.trim() || "Free";
}
