import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { env } from "@/lib/env";

/**
 * Singleton Stripe.js promise for Elements. Null when no publishable key is
 * configured (VITE_STRIPE_PUBLISHABLE_KEY) — the UI shows a setup hint instead.
 */
export const stripePromise: Promise<Stripe | null> | null = env.stripePublishableKey
  ? loadStripe(env.stripePublishableKey)
  : null;
