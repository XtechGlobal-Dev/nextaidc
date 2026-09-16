import type { Response } from "express";
import type { z } from "zod";

/** res.json with a schema check. Drift is OUR bug: throws outside production, logs and still serves in it.
 *  `data` is `unknown` on purpose — schemas are stricter than Prisma's types, and that gap is what this catches. */
export function sendValidated<Schema extends z.ZodTypeAny>(
  res: Response,
  schema: Schema,
  data: unknown,
): void {
  const result = schema.safeParse(data);
  if (!result.success) {
    console.error(
      `[contract-drift] ${res.req.method} ${res.req.originalUrl}`,
      result.error.flatten(),
    );
    if (process.env.NODE_ENV !== "production") throw result.error;
    res.json(data);
    return;
  }
  res.json(result.data);
}
