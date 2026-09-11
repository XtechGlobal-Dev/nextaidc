import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/*
 * Impersonation hands over a real session as somebody else, so the PIN is a
 * credential. These pin the parts that make it one rather than a formality:
 * it is verified against a hash, a missing hash means the DEFAULT is still in
 * force (not "let anything through"), and guesses are counted centrally so a
 * six-digit secret can't simply be enumerated.
 */

const store = new Map<string, string>();
const platformSetting = {
  findUnique: vi.fn(async ({ where }: { where: { key: string } }) =>
    store.has(where.key) ? { key: where.key, value: store.get(where.key)! } : null,
  ),
  upsert: vi.fn(async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
    store.set(where.key, create.value);
    return { key: where.key, value: create.value };
  }),
};

vi.mock("../prisma.js", () => ({ prisma: { platformSetting } }));

const {
  DEFAULT_PIN,
  MAX_ATTEMPTS,
  PIN_HASH_KEY,
  attemptsRemaining,
  clearFailures,
  isDefaultPin,
  isValidPinFormat,
  lockedForMs,
  maskEmail,
  registerFailure,
  setPin,
  verifyPin,
} = await import("./impersonationPin.js");

// upsert's mock takes `create.value`, so the update path must supply the same
// value — which the real code does. Kept explicit so a divergence would show up
// here rather than as a silently unsaved PIN.
beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe("PIN format", () => {
  it("requires exactly six digits", () => {
    expect(isValidPinFormat("123456")).toBe(true);
    expect(isValidPinFormat("12345")).toBe(false);
    expect(isValidPinFormat("1234567")).toBe(false);
    expect(isValidPinFormat("12345a")).toBe(false);
    expect(isValidPinFormat("")).toBe(false);
  });
});

describe("verifyPin", () => {
  it("falls back to the default when no PIN has ever been set", () => {
    // The dangerous reading of "no hash stored" is "nothing to check". It has to
    // mean "still on the shipped default" instead.
    return expect(verifyPin(DEFAULT_PIN)).resolves.toBe(true);
  });

  it("rejects anything else while on the default", async () => {
    await expect(verifyPin("123456")).resolves.toBe(false);
  });

  it("accepts the new PIN once set, and stops accepting the default", async () => {
    await setPin("482915");

    await expect(verifyPin("482915")).resolves.toBe(true);
    await expect(verifyPin(DEFAULT_PIN)).resolves.toBe(false);
  });

  it("never stores the PIN in readable form", async () => {
    await setPin("482915");

    const stored = store.get(PIN_HASH_KEY)!;
    expect(stored).not.toContain("482915");
    expect(stored.startsWith("$2")).toBe(true); // bcrypt
  });

  it("reports whether the default is still in force", async () => {
    await expect(isDefaultPin()).resolves.toBe(true);
    await setPin("482915");
    await expect(isDefaultPin()).resolves.toBe(false);
  });
});

describe("lockout", () => {
  it("opens after MAX_ATTEMPTS wrong tries, not before", async () => {
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      await expect(registerFailure()).resolves.toBe(0);
      await expect(lockedForMs()).resolves.toBe(0);
    }

    await expect(registerFailure()).resolves.toBeGreaterThan(0);
    await expect(lockedForMs()).resolves.toBeGreaterThan(0);
  });

  it("counts down the attempts it will allow", async () => {
    await expect(attemptsRemaining()).resolves.toBe(MAX_ATTEMPTS);
    await registerFailure();
    await expect(attemptsRemaining()).resolves.toBe(MAX_ATTEMPTS - 1);
  });

  it("clears the run of failures on success", async () => {
    await registerFailure();
    await registerFailure();

    await clearFailures();

    await expect(attemptsRemaining()).resolves.toBe(MAX_ATTEMPTS);
    await expect(lockedForMs()).resolves.toBe(0);
  });

  it("survives a restart, because the count is in the database", async () => {
    // An in-memory counter would hand out a fresh five on every deploy, which
    // for a million-combination secret is the difference between a real limit
    // and a speed bump.
    await registerFailure();
    await registerFailure();

    expect([...store.keys()].some((k) => k.includes("Lock"))).toBe(true);
    await expect(attemptsRemaining()).resolves.toBe(MAX_ATTEMPTS - 2);
  });

  it("treats a corrupt lock row as clean rather than locking the admin out forever", async () => {
    store.set("admin.impersonationPinLock", "not json");

    await expect(lockedForMs()).resolves.toBe(0);
    await expect(attemptsRemaining()).resolves.toBe(MAX_ATTEMPTS);
  });

  it("resets the counter with the lockout, so serving it buys a fresh set", async () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) await registerFailure();

    // Locked, but the counter is back to zero — otherwise the admin would be
    // left on one attempt per lockout window forever after.
    await expect(attemptsRemaining()).resolves.toBe(MAX_ATTEMPTS);
    await expect(lockedForMs()).resolves.toBeGreaterThan(0);
  });

  it("wipes failures when a new PIN is set", async () => {
    await registerFailure();
    await registerFailure();

    await setPin("482915");

    await expect(attemptsRemaining()).resolves.toBe(MAX_ATTEMPTS);
  });
});

/* The endpoint is the thing being protected. Source-pinned, in the style of
 * couponUpdate.test.ts, because the handler is a long Express route wired to
 * Prisma, JWTs and the audit log. */
const adminRoutes = readFileSync(
  resolve(import.meta.dirname, "../routes/admin.routes.ts"),
  "utf8",
);

const impersonateRoute = (() => {
  const chunk = adminRoutes
    .split(/router\.(?:get|post|patch|put|delete)\(/)
    .find((c) => /^\s*"\/customers\/:id\/impersonate"/.test(c));
  expect(chunk, "impersonate route not found").toBeDefined();
  return chunk!;
})();

describe("POST /customers/:id/impersonate", () => {
  it("verifies the PIN, on the server", () => {
    // The dialog is hidden behind an emoji and validates nothing that matters.
    // If this check is not here, the endpoint is open to any admin session with
    // curl and the whole feature is theatre.
    expect(impersonateRoute).toMatch(/await verifyPin\(pin\)/);
  });

  it("refuses to mint a token before the PIN is checked", () => {
    expect(impersonateRoute.indexOf("await verifyPin(pin)")).toBeLessThan(
      impersonateRoute.indexOf("signToken("),
    );
  });

  it("checks the PIN before looking the customer up, so it can't probe for ids", () => {
    // The lookup is in the admin's own brand's database, which is opened only
    // after the PIN has been checked.
    expect(impersonateRoute.indexOf("await verifyPin(pin)")).toBeLessThan(
      impersonateRoute.indexOf("db.user.findUnique"),
    );
  });

  it("scopes the customer lookup to the admin's tenant", () => {
    // Without this a brand admin could sign in as ANY customer on the platform
    // just by knowing their id — the PIN gate says "an admin is really here",
    // not "this customer is theirs".
    // The database IS the tenant: the customer is read from the admin's own
    // brand's database, where nobody else's customer exists.
    expect(impersonateRoute).toMatch(/requestTenant\(req\)/);
  });

  it("honours an active lockout", () => {
    expect(impersonateRoute).toMatch(/await lockedForMs\(\)/);
  });

  it("counts a wrong PIN, and clears the run on success", () => {
    expect(impersonateRoute).toMatch(/await registerFailure\(\)/);
    expect(impersonateRoute).toMatch(/await clearFailures\(\)/);
  });

  it("audit-logs failed attempts, not just successful entries", () => {
    // A run of failures is the signal that someone is guessing; logging only
    // the success that eventually follows hides exactly the interesting part.
    expect(impersonateRoute).toMatch(/customer\.impersonate\.pin_failed/);
  });
});

describe("masked email", () => {
  it("shows enough to recognise the inbox and no more", () => {
    expect(maskEmail("admin@xtecglobal.com")).toBe("a••••@xtecglobal.com");
  });

  it("never returns fewer than three dots, so a short local part isn't guessable", () => {
    expect(maskEmail("jo@x.com")).toBe("j•••@x.com");
  });

  it("degrades safely on something that isn't an address", () => {
    expect(maskEmail("not-an-email")).toBe("•••");
  });
});

const routeChunk = (match: RegExp) => {
  const chunk = adminRoutes
    .split(/router\.(?:get|post|patch|put|delete)\(/)
    .find((c) => match.test(c));
  expect(chunk, `route ${match} not found`).toBeDefined();
  return chunk!;
};

describe("forgot-PIN reset", () => {
  const start = () => routeChunk(/^\s*"\/impersonation-pin\/reset\/start"/);
  const complete = () => routeChunk(/^\s*"\/impersonation-pin\/reset\/complete"/);

  it("emails the code to the SESSION's address, never one from the request", () => {
    // A "send it to this address" parameter would turn account recovery into
    // account takeover.
    expect(start()).toMatch(/const email = req\.user!\.email/);
    expect(start()).not.toMatch(/req\.body/);
  });

  it("uses its own OTP purpose, not the password-reset one", () => {
    // Sharing a purpose would let a code issued for one act perform the other.
    expect(start()).toMatch(/purpose: "impersonation_pin_reset"/);
    expect(complete()).toMatch(/"impersonation_pin_reset"/);
  });

  it("consumes the code before writing the new PIN, so a replay can't set it twice", () => {
    const body = complete();
    expect(body.indexOf("consumeOtp(")).toBeLessThan(body.indexOf("setPin(newPin)"));
  });

  it("still enforces the PIN rules on the new value", () => {
    expect(complete()).toMatch(/isValidPinFormat\(newPin\)/);
    expect(complete()).toMatch(/newPin === DEFAULT_PIN/);
  });

  it("clears the lockout that belonged to the forgotten PIN", () => {
    expect(complete()).toMatch(/await clearFailures\(\)/);
  });

  it("audit-logs both halves of the reset", () => {
    expect(start()).toMatch(/impersonation_pin\.reset_requested/);
    expect(complete()).toMatch(/impersonation_pin\.reset_completed/);
  });

  it("is admin-only at both ends", () => {
    expect(start()).toMatch(/requireAdmin/);
    expect(complete()).toMatch(/requireAdmin/);
  });
});
