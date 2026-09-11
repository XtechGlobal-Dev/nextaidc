import type { AgentConfig } from "@/types";
import { compileMasterPrompt } from "@/lib/compilePrompt";
import { seededSmsInfoItems } from "@/data/smsInfoItems";

/** Neutral defaults for a brand-new agent. Real details come from onboarding. */
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  identity: {
    assistantName: "Sophie",
    businessName: "",
    voiceId: "EXAVITQu4vr4xnSDxMaL", // Sarah — ElevenLabs female (universal default); mirrors server DEFAULT_AGENT_VOICE_ID
    greetingMessage: "Thanks for calling. How can I help you today?",
    languages: [],
  },
  knowledge: {
    quickFacts: [],
    services: [],
    captureFields: [
      { id: "cf_name", label: "Caller's first name", enabled: true },
      { id: "cf_phone", label: "Do not ask for the contact number. Automatically use the caller's phone number as the contact number unless they provide a different one.", enabled: true },
    ],
    faqs: [],
  },
  rules: {
    // Blank = not yet resolved; signup and the GET /api/agent read resolve one
    // from the business's phone/address, and the Rules section confirms it.
    timezone: "",
    scenarioHandling: [
      { id: "sc_book", ifText: "The caller wants to book a job or site visit", thenText: "Capture their details and offer the next available slot" },
      { id: "sc_existing", ifText: "The caller is an existing customer", thenText: "Take a message and assure them the team will call back" },
      { id: "sc_quoted", ifText: "The caller has already been quoted", thenText: "Note their name and pass it to the owner to follow up" },
      { id: "sc_upset", ifText: "The caller is upset or frustrated", thenText: "Stay calm, apologise, and promise a prompt callback from the owner" },
      { id: "sc_owner", ifText: "The caller asks operational questions only the owner can answer", thenText: "Take a message rather than guessing" },
      { id: "sc_price", ifText: "The caller asks for a price or quote", thenText: "Explain quotes are tailored and capture details for a callback" },
    ],
    pricing: {
      behaviour:
        "Do not give firm prices over the phone — every job is quoted on site. Reassure callers quotes are free and obligation-free.",
      fixedItemsEnabled: false,
      fixedItems: [],
    },
    declineCalls: [
      "Marketing, sales or SEO pitches",
      "Recruitment / job-seeker enquiries",
      "Free, charity or unpaid work requests",
      "Hazardous or out-of-scope work",
      "Services we do not offer",
    ],
    businessHours: "Monday to Friday, 9:00am – 5:00pm. Closed weekends and public holidays.",
    humanHandover: { enabled: false, transferNumber: "" },
  },
  automations: {
    // Email + WhatsApp owner summaries on by default; SMS OFF by default (per-message
    // cost — owner opts in). They deliver to the account's signup email / mobile
    // until the user overrides the source below.
    ownerEmailSummary: true,
    ownerSmsSummary: false,
    // Master switch for "Text Info to Callers". OFF by default — it costs per
    // message, and the owner should review the templates before it goes live.
    clientPostCallSms: false,
    ownerWhatsAppSummary: true,
    summaryEmail: "",
    summarySmsNumber: "",
    summaryWhatsAppNumber: "",
    // Public conversation link on by default, valid for 30 days (720h).
    smsIncludeConversationLink: true,
    whatsAppIncludeConversationLink: true,
    conversationLinkValidityHours: 720,
    // Empty → summaries/transcripts stay in the call's own language (English).
    reportLanguage: "",
    // Seeded catalogue for "Text Info to Callers" — ready to use the moment the
    // owner flips clientPostCallSms on.
    smsOnRequest: { items: seededSmsInfoItems() },
  },
  advanced: {
    masterPrompt: "",
    masterPromptDirty: false,
    creativity: 0.3,
    voiceStability: 0.45,
    voiceSpeed: 1.05,
    allowHangUp: true,
    // Office ambience is the one we want every new agent to start with — it makes
    // the line sound staffed rather than dead. "default" defers to Vapi, which is
    // not the same thing and can change under us. Only the SEED changes: an agent
    // that already exists keeps whatever its owner has set (or left unset).
    backgroundSound: "office",
  },
};

// Pre-compile the master prompt for the seeded config.
DEFAULT_AGENT_CONFIG.advanced.masterPrompt = compileMasterPrompt(DEFAULT_AGENT_CONFIG);
