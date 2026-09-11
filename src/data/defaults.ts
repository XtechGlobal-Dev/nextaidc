import type { ChatMessage, CrmIntegration, Profile } from "@/types";
import { env } from "@/lib/env";

/* ------------------------------------------------------------------ *
 *  Default initial state for the data stores before they hydrate from
 *  the backend. These are empty/neutral defaults — not sample data.
 * ------------------------------------------------------------------ */

export const CONVERSION_ID = "conv_local";

export const DEFAULT_PROFILE: Profile = {
  id: "",
  fullName: "",
  businessName: "",
  email: "",
  mobile: "",
  website: "",
  businessNumber: "",
  address: "",
  country: "",
  industry: "",
  plan: "free",
  testMinutesUsed: 0,
  webTestMinutesUsed: 0,
  webTestCycleStart: "2026-06-01T00:00:00.000Z",
  receptionistNumber: "",
  numberActivated: false,
  forwardingMode: "",
  forwardingConfirmedAt: null,
  onboardingStep: 0,
  onboardingCompletedAt: null,
};

export const DEFAULT_CRM: CrmIntegration = {
  connectedProvider: null,
  googleCalendarConnected: false,
  customWebhookUrl: "",
  nexleonUrl: null,
  nexleonFormKey: null,
  bookingEnabled: true,
  bookingDurationMin: 30,
  bookingCalendarId: "primary",
  bookingTimezone: "",
};

/** A single system greeting for the support widget (shown before chat history loads). */
export const DEFAULT_CHAT_MESSAGES: ChatMessage[] = [
  {
    id: "msg_1",
    conversationId: "chat_demo",
    role: "assistant",
    content:
      `Hi! 👋 I'm the ${env.appName} support assistant. How can I help you set up your AI receptionist?`,
    createdAt: "2026-06-18T00:00:00.000Z",
  },
];
