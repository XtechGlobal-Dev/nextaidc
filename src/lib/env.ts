/**
 * Central access to Vite env. The app always talks to the backend API;
 * `apiUrl` falls back to this deployment's own API in a production build and
 * to the local dev server otherwise — so a build that ships without
 * VITE_API_URL still reaches the real API instead of a localhost that only
 * exists on a developer's machine, and `npm run dev` still never touches
 * production data.
 */
const PROD_API_URL = "https://nextaidc-api.onrender.com";
const DEV_API_URL = "http://localhost:4000";

export const env = {
  apiUrl: (
    import.meta.env.VITE_API_URL ?? (import.meta.env.PROD ? PROD_API_URL : DEV_API_URL)
  ).trim(),
  appName: import.meta.env.VITE_APP_NAME ?? "NextAIDC",
  supportEmail: import.meta.env.VITE_SUPPORT_EMAIL ?? "connect@hello22.ai",
  supportPhone: import.meta.env.VITE_SUPPORT_PHONE ?? "7973066221",
  supportWhatsapp: import.meta.env.VITE_SUPPORT_WHATSAPP ?? "https://wa.me/7973066221",
  vapiPublicKey: import.meta.env.VITE_VAPI_PUBLIC_KEY ?? "",
  stripePublishableKey: import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY ?? "",
};
