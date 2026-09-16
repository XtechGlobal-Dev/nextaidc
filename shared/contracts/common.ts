import { z } from "zod";

// Shared Zod response schemas — one source of truth used by the server (sendValidated) and the frontend
// (inferred types). Opt-in per route.
export const OkResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponseSchema>;
