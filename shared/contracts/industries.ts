import { z } from "zod";

/** server/src/routes/industries.routes.ts — GET / */
export const IndustriesListResponseSchema = z.object({
  industries: z.array(z.string()),
});
export type IndustriesListResponse = z.infer<typeof IndustriesListResponseSchema>;

/** server/src/routes/industries.routes.ts — POST /suggest */
export const IndustrySuggestResponseSchema = z.object({
  status: z.enum(["submitted", "exists", "pending"]),
  value: z.string(),
});
export type IndustrySuggestResponse = z.infer<typeof IndustrySuggestResponseSchema>;
