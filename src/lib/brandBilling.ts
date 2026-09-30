import type { BrandBillingStatus, BrandServiceHold } from "@/lib/api";

// How a brand's standing with the platform reads everywhere it's shown (list, brand page, analytics,
// the brand admin's own Billing page), so the same state never has two names.

type Variant = "success" | "warning" | "danger" | "neutral";

export function billingStatusMeta(status: BrandBillingStatus | undefined): { label: string; variant: Variant } {
  switch (status) {
    case "active":
      return { label: "Paid", variant: "success" };
    case "awaiting_card":
      return { label: "Awaiting payment", variant: "warning" };
    case "past_due":
      return { label: "Payment failed", variant: "danger" };
    case "canceled":
      return { label: "Canceled", variant: "danger" };
    default:
      return { label: "No fee", variant: "neutral" };
  }
}

/** What a hold means, for the brand's own people and for the super admin. */
export function serviceHoldCopy(hold: BrandServiceHold): { title: string; body: string } | null {
  switch (hold) {
    case "minutes":
      return {
        title: "Call minutes used up",
        body: "This month's call-minute limit is reached, so the AI isn't answering calls until the 1st (UTC) or until the limit is raised. Texts and replies still work.",
      };
    case "ai":
      return {
        title: "AI interactions used up",
        body: "This month's AI interaction limit is reached, so the AI is paused on every channel until the 1st (UTC) or until the limit is raised.",
      };
    case "billing":
      return {
        title: "AI paused for an unpaid bill",
        body: "The platform subscription is overdue past its grace period, so every customer's AI is paused until it's paid.",
      };
    default:
      return null;
  }
}
