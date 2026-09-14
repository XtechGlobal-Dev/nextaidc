import type { Response } from "express";
import type { z } from "zod";

/**
 * Sends `data` as JSON after checking it against `schema` — the response-side
 * half of the API contract pilot (request bodies are already Zod-validated
 * per-route; nothing previously checked what actually went back out).
 *
 * Opt-in per route, not a global middleware: only routes that have been
 * migrated to a shared schema call this instead of `res.json(data)`.
 *
 * A mismatch never turns into a 400 to the caller — unlike a REQUEST
 * validation failure, a response shape drifting from its schema is a bug in
 * OUR code, not the caller's. Outside production it throws so the mismatch
 * fails a test/CI run loudly and immediately; in production it logs and
 * still serves the original data, since silently 500-ing a live endpoint
 * over a schema bug would be worse than the drift itself.
 *
 * `data` is deliberately `unknown`, not `z.input<Schema>`: a schema is often
 * intentionally STRICTER than what Prisma's own types can prove (e.g. a
 * `String` column modeling a closed set of values, like Notification.type) —
 * that gap is exactly what this function exists to catch at runtime, so
 * forcing it to also type-check would just push routes back to an unchecked
 * `res.json(data)` the moment the two don't line up structurally.
 */
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
