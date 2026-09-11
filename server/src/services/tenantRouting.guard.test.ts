import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/* ------------------------------------------------------------------ *
 *  A structural guard, not a behaviour test.
 *
 *  A brand's customer data lives in the brand's own database, and since
 *  phase 6 so do its accounts: the control plane holds only the
 *  platform's own things. A `prisma.profile.update(...)` added in six
 *  months would not even compile any more (the model is gone from the
 *  control-plane client) — but a `prisma.ticket` or `prisma.user` would,
 *  because the platform keeps its own tickets and its own people in
 *  tables of the same shape. So no file under src/ may name a shared-
 *  shape model on the control-plane client except the ones listed, each
 *  with a reason. Everything else goes through `tenantFor` /
 *  `tenantForUser` / `requestTenant` / `planeOf` (services/tenantDb.ts)
 *  or, for calls, createCall/updateCall (services/callWrite.ts).
 * ------------------------------------------------------------------ */

const SRC = join(import.meta.dirname, "..");

/** Files allowed to name these models on the control-plane client, and why. */
const ALLOWED = new Map<string, string>([
  ["services/otp.ts", "the platform's own door keeps its codes in the control plane's table"],
  ["middleware/auth.ts", "a token naming no brand is one of the platform's own people, read from Main"],
  ["routes/auth.routes.ts", "the platform's own people sign in from Main; everyone else from their brand's door"],
  ["routes/brands.routes.ts", "a new brand's first admin must not collide with one of the platform's own people"],
  ["services/notifications.ts", "notifyAdmins reaches the platform's owners, who live in Main"],
  ["services/voices.ts", "the platform's own people have no brand; their role is read from Main"],
]);

// A word boundary spelled out ([^A-Za-z0-9_$] / a negative lookahead) rather
// than with backslash escapes, which do not survive the shell this file is
// maintained through.
const CONTROL_PLANE_USE =
  /(?:^|[^A-Za-z0-9_$])(?:prisma|tx)[.](?:user|callLog|verificationCode|webhookDelivery|appointment|chatConversation|chatMessage|humanTransferSettings|transferDepartment|crmIntegration|planEvent|profile|conversion|couponRedemption|commission|brandMember|ticket|ticketMessage|ticketMerge|ticketMessageReaction|ticketAttachment|ticketDepartment|ticketSavedReply|staffRole|notification)(?![A-Za-z0-9_$])/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith(".ts") && !entry.includes(".test.")) out.push(full);
  }
  return out;
}

describe("customer data is not read or written on the control plane", () => {
  const files = sourceFiles(SRC);

  it("finds the source tree (guards against the scan silently matching nothing)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("keeps the allow-list honest: every listed file exists and still needs listing", () => {
    for (const [name] of ALLOWED) {
      const source = readFileSync(join(SRC, name), "utf8");
      expect(
        CONTROL_PLANE_USE.test(source),
        `${name} no longer touches a shared-shape model on the control plane — drop it from ALLOWED`,
      ).toBe(true);
    }
  });

  for (const file of files) {
    const name = relative(SRC, file).split(sep).join("/");
    if (ALLOWED.has(name)) continue;
    const source = readFileSync(file, "utf8");
    if (!CONTROL_PLANE_USE.test(source)) continue;

    it(`${name} does not touch a brand's table on the control plane`, () => {
      const line = source.split("\n").findIndex((l) => CONTROL_PLANE_USE.test(l)) + 1;
      const what = source.match(CONTROL_PLANE_USE)?.[0] ?? "a brand's model";
      expect.fail(
        `${name}:${line} reaches for ${what}. That table lives in each brand's own database — ` +
          `open it with tenantFor / tenantForUser / requestTenant / planeOf (services/tenantDb.ts), or add ` +
          `this file to ALLOWED with a reason.`,
      );
    });
  }
});
