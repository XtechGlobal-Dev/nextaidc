/* ------------------------------------------------------------------ *
 *  Agent configuration — the structured config that compiles into a
 *  master system prompt + voice params, stored as `agent_config`.
 *  This is the core data model of the product (the "AI Brain").
 * ------------------------------------------------------------------ */

export type VoiceRegion = "Australian" | "British" | "American" | "Filipino";

export interface VoiceOption {
  id: string;
  name: string;
  region: VoiceRegion;
  descriptor: string; // e.g. "Warm & Friendly"
  premium: boolean; // PLAN-gated
  /** Optional sample url for the preview play button (mock). */
  sampleUrl?: string;
}

export interface QuickFact {
  id: string;
  key: string; // e.g. "Service Area"
  value: string; // e.g. "Sydney metro and surrounding suburbs"
}

export interface CaptureField {
  id: string;
  label: string; // e.g. "Caller's first name"
  enabled: boolean;
}

export interface FaqItem {
  id: string;
  question: string; // e.g. "Do you offer free quotes?"
  answer: string; // e.g. "Yes, all quotes are free and obligation-free."
}

export interface ScenarioRule {
  id: string;
  ifText: string; // condition
  thenText: string; // instruction
}

export interface FixedPriceItem {
  id: string;
  item: string;
  price: string; // free text so "$120 / sqm" etc. is allowed
}

export interface IdentitySection {
  assistantName: string;
  businessName: string;
  voiceId: string;
  greetingMessage: string;
  /** Voice provider this agent was set up with; stamped server-side and sticky, so
   *  a global toggle change never retroactively switches an existing agent. Unset on
   *  legacy configs → resolved from the voiceId. */
  voiceProvider?: "deepgram" | "elevenlabs";
  /** Extra languages the assistant may answer in (multilingual plans only, PLAN-gated).
   *  English is always the base and isn't stored here. Empty/absent → English only. */
  languages?: string[];
  /** ISO 3166-1 alpha-2 country (uppercase) captured at onboarding — drives the
   *  regional style block on the live assistant. Set server-side; not user-edited. */
  country?: string;
}

export interface KnowledgeSection {
  quickFacts: QuickFact[];
  /** Services the business offers — seeded from onboarding/website, editable here. */
  services: string[];
  captureFields: CaptureField[];
  faqs: FaqItem[];
}

export interface PricingConfig {
  behaviour: string; // how the AI should talk about pricing
  fixedItemsEnabled: boolean;
  fixedItems: FixedPriceItem[];
}

export interface HumanHandoverConfig {
  enabled: boolean; // PLAN-gated
  transferNumber: string;
}

export interface RulesSection {
  timezone: string;
  scenarioHandling: ScenarioRule[];
  pricing: PricingConfig;
  declineCalls: string[]; // chips
  businessHours: string;
  humanHandover: HumanHandoverConfig;
}

/**
 * One piece of business information the AI can text to a caller who asks for it
 * mid-call ("what's your website?" → "sure, want me to text you the link?").
 *
 * The AI never writes the message: it only picks a `key`, and the body is
 * rendered server-side from `template`. That boundary is deliberate — it means a
 * caller can't talk the agent into sending arbitrary text from the business's
 * Twilio number.
 */
export interface SmsInfoItem {
  id: string;
  /** Stable key the AI passes as the tool's `topic` (its enum value). */
  key: string;
  /** Owner-facing name, e.g. "Website link". */
  label: string;
  enabled: boolean;
  /** Hint that teaches the AI which caller questions this item answers. */
  whenToUse: string;
  /** SMS body. Supports {{business}} {{website}} {{email}} {{address}} {{phone}} {{hours}}. */
  template: string;
  /** Owner-created rather than seeded — only these can be deleted. */
  custom?: boolean;
}

/** The caller-facing "text me that" catalogue. Master on/off lives on
 *  `clientPostCallSms` (kept for backwards compatibility with stored configs). */
export interface SmsOnRequestConfig {
  items: SmsInfoItem[];
}

export interface AutomationsSection {
  ownerEmailSummary: boolean;
  ownerSmsSummary: boolean;
  /** Master switch for "Text Info to Callers" (see `smsOnRequest`). Historically a
   *  dormant post-call flag that never sent anything — repurposed rather than
   *  replaced so no stored config needs migrating. */
  clientPostCallSms: boolean;
  ownerWhatsAppSummary: boolean;
  /**
   * Where post-call summaries are delivered. Each is optional — when blank the
   * notification falls back to the account's default email / mobile number.
   */
  summaryEmail: string;
  summarySmsNumber: string;
  summaryWhatsAppNumber: string;
  /** Include a public "More info" conversation link in the summary SMS. */
  smsIncludeConversationLink: boolean;
  /** Include the same conversation link in the WhatsApp summary. */
  whatsAppIncludeConversationLink: boolean;
  /** How long that public link stays valid, in hours. 0 = never expires. */
  conversationLinkValidityHours: number;
  /** Language the owner wants their summaries + transcripts delivered in.
   *  Empty or "English" → no translation (the call's own language). */
  reportLanguage: string;
  /** What the AI may text a caller who asks for it during the call. */
  smsOnRequest: SmsOnRequestConfig;
}

export interface AdvancedSection {
  /** Compiled (or manually edited) master prompt. */
  masterPrompt: string;
  /** True once the user hand-edits the prompt; stops auto-overwrite. */
  masterPromptDirty: boolean;
  creativity: number; // 0..1, default 0.3
  voiceStability: number; // 0..1, default 0.45
  voiceSpeed: number; // 0.5..2, default 1.05
  allowHangUp: boolean;
  /** Ambient sound the caller hears under the call. "off" = silent, "office" =
   *  gentle office ambience, "default" = let the platform decide (office on a
   *  phone call). Maps to Vapi's backgroundSound. Default: "default". */
  backgroundSound: "off" | "office" | "default";
}

export interface AgentConfig {
  identity: IdentitySection;
  knowledge: KnowledgeSection;
  rules: RulesSection;
  automations: AutomationsSection;
  advanced: AdvancedSection;
}

export type AgentSectionKey =
  | "identity"
  | "knowledge"
  | "rules"
  | "automations"
  | "advanced";
