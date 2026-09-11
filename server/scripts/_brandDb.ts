import { prisma as main } from "../src/prisma.js";
import { tenantFor } from "../src/services/tenantDb.js";

/* ------------------------------------------------------------------ *
 *  A database client for one-off maintenance scripts, after phase 6.
 *
 *  A customer's profile, agent record, calls and the rest of their
 *  workspace live in their brand's own database; the platform's tables
 *  stay in Main. These scripts were written when everything was in one
 *  place and address models directly (`prisma.conversion.findMany`), so
 *  this client routes each model to the plane it lives in — the brand
 *  named by BRAND=<slug> for the brand's models, Main for the rest:
 *
 *      BRAND=acme npm run backfill-greetings
 *
 *  This ambient routing is deliberately confined to scripts run by hand
 *  against ONE brand. Application code names the database it means
 *  (services/tenantDb.ts) and never gets a client that guesses.
 * ------------------------------------------------------------------ */

const TENANT_MODELS = new Set([
  "user",
  "profile",
  "conversion",
  "callLog",
  "crmIntegration",
  "webhookDelivery",
  "humanTransferSettings",
  "transferDepartment",
  "appointment",
  "chatConversation",
  "chatMessage",
  "planEvent",
  "couponRedemption",
  "commission",
  "staffRole",
  "ticket",
  "ticketMessage",
  "ticketMerge",
  "ticketMessageReaction",
  "ticketAttachment",
  "ticketDepartment",
  "ticketSavedReply",
  "notification",
]);

const tenantReady = (async () => {
  const slug = process.env.BRAND?.trim();
  if (!slug) {
    throw new Error("Set BRAND=<slug> — this script works on one brand's database at a time (phase 6).");
  }
  const brand = await main.brand.findUnique({ where: { slug }, select: { id: true, name: true } });
  if (!brand) throw new Error(`No brand with slug "${slug}".`);
  console.log(`[brand-db] ${brand.name} (${slug})`);
  return tenantFor(brand.id);
})();

type AnyClient = Record<string | symbol, unknown>;

/** Main for the platform's models; the BRAND's database for the brand's. Every
 *  model method is async in Prisma, so the tenant may be resolved lazily. */
export const prisma = new Proxy(main as unknown as AnyClient, {
  get(target, model) {
    if (typeof model !== "string" || !TENANT_MODELS.has(model)) return target[model];
    return new Proxy(
      {},
      {
        get(_, method) {
          return (...args: unknown[]) =>
            tenantReady.then((t) => {
              const m = (t as unknown as AnyClient)[model] as Record<string | symbol, (...a: unknown[]) => unknown>;
              return m[method](...args);
            });
        },
      },
    );
  },
}) as unknown as typeof main;
