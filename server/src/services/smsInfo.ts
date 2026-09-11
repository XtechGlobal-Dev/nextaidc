import { tenantForUser } from "./tenantDb.js";
import { normalizeAutomations, type AgentConfig } from "../lib/agentConfig.js";
import {
  availableSmsInfoItems,
  type SmsInfoItem,
  type SmsInfoValues,
} from "../lib/smsInfoItems.js";

export type { SmsInfoValues } from "../lib/smsInfoItems.js";

/* ------------------------------------------------------------------ *
 *  "Text Info to Callers" — resolve what an owner's AI may text a caller.
 *
 *  The rendered message bodies are resolved HERE, server-side, from the owner's
 *  own templates and profile. The assistant only ever names a topic, so a caller
 *  can't talk it into sending arbitrary text from the business's number.
 * ------------------------------------------------------------------ */

export interface SmsInfoEntry {
  item: SmsInfoItem;
  /** The exact message this topic sends, already clamped to 160 chars. */
  body: string;
}

export interface SmsInfoConfig {
  /** The owner turned the feature on AND at least one item can actually send. */
  enabled: boolean;
  entries: SmsInfoEntry[];
  businessName: string;
  /** The resolved business details, for packing several items into one message. */
  values: SmsInfoValues;
}

const EMPTY_VALUES: SmsInfoValues = {
  business: "",
  website: "",
  email: "",
  address: "",
  phone: "",
  hours: "",
};

const DISABLED: SmsInfoConfig = {
  enabled: false,
  entries: [],
  businessName: "",
  values: EMPTY_VALUES,
};

/**
 * Load the owner's SMS-on-request catalogue with every message pre-rendered.
 * Best-effort — returns a disabled config on any miss or failure, so a tool call
 * mid-call degrades to "I'll read it out" instead of crashing.
 */
export async function getSmsInfoConfig(userId: string | null | undefined): Promise<SmsInfoConfig> {
  if (!userId) return DISABLED;
  try {
    const user = await (await tenantForUser(userId)).user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        conversion: { select: { agentConfig: true } },
        profile: {
          select: { businessName: true, website: true, address: true, businessNumber: true, mobile: true },
        },
      },
    });
    if (!user?.conversion) return DISABLED;

    const config = user.conversion.agentConfig as unknown as AgentConfig;
    const automations = normalizeAutomations(config?.automations);
    if (!automations.clientPostCallSms) return DISABLED;

    const profile = user.profile;
    const values: SmsInfoValues = {
      business: profile?.businessName?.trim() ?? "",
      website: profile?.website?.trim() ?? "",
      // The account email — the only address we hold for the business.
      email: user.email?.trim() ?? "",
      address: profile?.address?.trim() ?? "",
      // The number customers already call, falling back to the owner's mobile.
      phone: profile?.businessNumber?.trim() || profile?.mobile?.trim() || "",
      hours: config?.rules?.businessHours?.trim() ?? "",
    };

    const entries = availableSmsInfoItems(automations.smsOnRequest?.items, values);
    if (!entries.length) return DISABLED;
    return { enabled: true, entries, businessName: values.business, values };
  } catch {
    return DISABLED;
  }
}

/** Look a topic up in a resolved config. Case/space tolerant, because the model
 *  occasionally returns "Website" for an enum of "website". */
export function findSmsInfoEntry(config: SmsInfoConfig, topic: string): SmsInfoEntry | null {
  const want = topic.trim().toLowerCase();
  if (!want) return null;
  return (
    config.entries.find((e) => e.item.key.toLowerCase() === want) ??
    config.entries.find((e) => e.item.label.toLowerCase() === want) ??
    null
  );
}

/** Resolve a list of requested topics to their entries — validated against the
 *  owner's catalogue, de-duplicated, in the order the caller asked. Unknown
 *  topics are simply dropped. */
export function resolveSmsInfoTopics(config: SmsInfoConfig, topics: string[]): SmsInfoEntry[] {
  const out: SmsInfoEntry[] = [];
  const seen = new Set<string>();
  for (const topic of topics) {
    const entry = findSmsInfoEntry(config, topic);
    if (entry && !seen.has(entry.item.key)) {
      seen.add(entry.item.key);
      out.push(entry);
    }
  }
  return out;
}
