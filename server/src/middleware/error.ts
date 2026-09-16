import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { MulterError } from "multer";
import { HttpError } from "../lib/http.js";
import { TenantUnavailableError } from "../services/tenantDb.js";

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: "Route not found" });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  if (err instanceof TenantUnavailableError) {
    // The brand's database is being set up, migrated or paused: nothing of the
    // brand's can be served, and nobody is at fault. Say so, as the auth layer does.
    return res.status(503).json({ error: "This brand's database isn't available right now. Try again shortly.", code: "brand_not_ready" });
  }
  if (err instanceof ZodError) {
    const flat = err.flatten();
    // An object-level `.refine()` has no path, so its message lands in `formErrors` — dropping it left
    // the client with a bare "Validation failed".
    const firstMessage =
      flat.formErrors[0] ?? Object.values(flat.fieldErrors).flat().find((m): m is string => !!m);
    return res.status(400).json({
      error: firstMessage ?? "Validation failed",
      details: {
        ...flat.fieldErrors,
        ...(flat.formErrors.length > 0 ? { _errors: flat.formErrors } : {}),
      },
    });
  }
  if (err instanceof MulterError) {
    const msg = err.code === "LIMIT_FILE_SIZE" ? "File is too large (max 5 MB)." : err.message;
    return res.status(400).json({ error: msg });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "A record with that value already exists" });
    }
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Record not found" });
    }
  }
  console.error("Unhandled error:", err);
  // Surface the real message in non-production so issues are debuggable from the client.
  const message =
    process.env.NODE_ENV === "production"
      ? "Internal server error"
      : err instanceof Error
        ? err.message
        : "Internal server error";
  return res.status(500).json({ error: message });
}
