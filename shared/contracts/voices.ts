import { z } from "zod";

const VoiceGenderSchema = z.enum(["male", "female"]).nullable().optional();

/** A voice option in a specific provider's catalog (admin Voice Bank / plan editor). */
export const ProviderVoiceSchema = z.object({
  id: z.string(),
  name: z.string(),
  descriptor: z.string(),
  region: z.string(),
  previewUrl: z.string().nullable(),
  gender: VoiceGenderSchema,
  language: z.string().optional(),
});
export type ProviderVoice = z.infer<typeof ProviderVoiceSchema>;

/** server/src/routes/voices.routes.ts — GET /all */
export const AllVoicesResponseSchema = z.object({
  deepgram: z.array(ProviderVoiceSchema),
  elevenlabs: z.array(ProviderVoiceSchema),
});
export type AllVoicesResponse = z.infer<typeof AllVoicesResponseSchema>;

/** A voice annotated for the current user (entitlement + upsell hint + which
 *  provider it came from) — resolveVoices() always attaches `provider`. */
export const VoiceCatalogItemSchema = ProviderVoiceSchema.extend({
  provider: z.enum(["deepgram", "elevenlabs"]),
  entitled: z.boolean(),
  plans: z.array(z.string()),
});
export type VoiceCatalogItem = z.infer<typeof VoiceCatalogItemSchema>;

/** server/src/routes/voices.routes.ts — GET / */
export const VoiceCatalogResponseSchema = z.object({
  voices: z.array(VoiceCatalogItemSchema),
  current: VoiceCatalogItemSchema.nullable(),
  locked: z.boolean(),
  category: z.string().nullable(),
  currentPlanName: z.string().nullable(),
});
export type VoiceCatalogResponse = z.infer<typeof VoiceCatalogResponseSchema>;
