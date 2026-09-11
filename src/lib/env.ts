/**
 * Central access to Vite env. The app always talks to the backend API;
 * `apiUrl` defaults to the local dev server when VITE_API_URL is unset.
 */
export const env = {
  apiUrl: (import.meta.env.VITE_API_URL ?? "http://localhost:4000").trim(),
  appName: import.meta.env.VITE_APP_NAME ?? "hello22.ai",
  supportEmail: import.meta.env.VITE_SUPPORT_EMAIL ?? "connect@hello22.ai",
  supportPhone: import.meta.env.VITE_SUPPORT_PHONE ?? "+61 1300 000 000",
  supportWhatsapp: import.meta.env.VITE_SUPPORT_WHATSAPP ?? "https://wa.me/611300000000",
  vapiPublicKey: import.meta.env.VITE_VAPI_PUBLIC_KEY ?? "",
  stripePublishableKey: import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY ?? "",
};
