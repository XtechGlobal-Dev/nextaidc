import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { env } from "@/lib/env";

/** Singleton Stripe.js promise for Elements; null when VITE_STRIPE_PUBLISHABLE_KEY is unset (UI shows a setup hint). */
export const stripePromise: Promise<Stripe | null> | null = env.stripePublishableKey
  ? loadStripe(env.stripePublishableKey)
  : null;
