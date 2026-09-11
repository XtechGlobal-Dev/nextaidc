import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

/* The grandfathering guarantee, enforced mechanically.
 *
 * The whole design rests on one rule: `onboarding.cardRequired` is read ONCE, at
 * account creation, and frozen onto Profile.cardRequiredAtSignup. Every gate
 * downstream reads that column instead. The day someone "helpfully" reads the
 * live setting inside an entitlement check or a middleware, flipping the admin
 * toggle starts retroactively walling paying customers — a silent, severe
 * regression that no behavioural test would catch, because each piece still
 * works in isolation.
 *
 * createUser is 100+ lines wired to email/notifications/Stripe, so these are
 * source-text assertions in the house style (see planActivation.test.ts). */

const SERVER_SRC = resolve(import.meta.dirname, "..");
const authSrc = readFileSync(join(SERVER_SRC, "routes/auth.routes.ts"), "utf8");

/** Every .ts file under server/src, excluding tests. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("the signup snapshot is stamped", () => {
  it("writes cardRequiredAtSignup onto the new profile", () => {
    expect(authSrc).toMatch(/cardRequiredAtSignup: cardRequired/);
  });

  it("falls back to the live setting only when no frozen value was passed in", () => {
    expect(authSrc).toMatch(
      /const cardRequired = data\.cardRequired \?\? \(await getOnboardingCardRequired\(\)\)/,
    );
  });

  it("freezes the policy at /register/start so the OTP window can't change it", () => {
    const start = authSrc.indexOf('"/register/start"');
    expect(start, "/register/start route not found").toBeGreaterThan(-1);
    const handler = authSrc.slice(start, authSrc.indexOf("router.post(", start + 10));
    expect(handler).toMatch(/cardRequired: await getOnboardingCardRequired\(\)/);
  });

  it("does NOT re-stamp on the /register/verify recovery path", () => {
    // That branch re-issues a session for an account that already exists. Reading
    // the toggle there would re-decide policy for a live account on every retry.
    const start = authSrc.indexOf('"/register/verify"');
    expect(start, "/register/verify route not found").toBeGreaterThan(-1);
    const handler = authSrc.slice(start, authSrc.indexOf("const emailOnlySchema", start));
    const recovery = handler.slice(handler.indexOf("if (existing)"), handler.indexOf("consumeOtp"));
    expect(recovery).not.toMatch(/getOnboardingCardRequired|cardRequiredAtSignup/);
  });
});

describe("GRANDFATHERING: nothing outside signup reads the live toggle", () => {
  it("only auth.routes.ts and admin.routes.ts import getOnboardingCardRequired", () => {
    const offenders = sourceFiles(SERVER_SRC)
      .filter((f) => readFileSync(f, "utf8").includes("getOnboardingCardRequired"))
      .map((f) => f.slice(SERVER_SRC.length + 1).replace(/\\/g, "/"))
      // settings.ts defines it; auth stamps it at signup; admin serves the toggle UI.
      .filter((f) => !["services/settings.ts", "routes/auth.routes.ts", "routes/admin.routes.ts"].includes(f));

    expect(
      offenders,
      "Reading the live card-required setting outside signup breaks grandfathering: " +
        "flipping the admin toggle would retroactively wall existing customers. " +
        "Read profile.cardRequiredAtSignup instead.",
    ).toEqual([]);
  });

  it("getEntitlement decides from the profile row, not the platform setting", () => {
    const trialSrc = readFileSync(join(SERVER_SRC, "services/trial.ts"), "utf8");
    // The wall reads the account's own two columns and nothing else.
    expect(trialSrc).toMatch(
      /if \(profile && profile\.cardRequiredAtSignup && !profile\.cardConfirmedAt\)/,
    );
    expect(trialSrc).not.toMatch(/platformSetting/);
  });
});
