import { z } from "zod";

/**
 * Shared Zod response schemas: the single source of truth for a route's
 * response shape, imported by both the backend (to validate what it sends,
 * via server/src/lib/respond.ts) and the frontend (as the inferred type for
 * its src/lib/api.ts call sites) — see the API contract enforcement pilot.
 * This is additive, opt-in per route; most routes don't use these yet.
 */
export const OkResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponseSchema>;
