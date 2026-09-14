import { describe, it, expect, vi } from "vitest";

// Token type isolation: every token shares JWT_SECRET, so each verifier must check `kind`. Regression
// guard for the account takeover where a non-expiring unsubscribe link verified as a full login.

vi.mock("../env.js", () => ({
  // Brand hosts resolve against these; the real module exports them, so a
  // mock that omits them fails to link for anything importing brandUrls.
  platformDomain: "hello22.ai",
  platformDomains: ["hello22.ai"],
  allowUnverifiedBrandDomains: false,
  canonicalApiBaseUrl: "https://api.test",
  env: { JWT_SECRET: "test-secret-abcdefgh", JWT_EXPIRES_IN: "7d" },
}));

const { signToken, verifyToken, signUnsubscribe, signState, signRecording, verifyRecording } =
  await import("./jwt.js");

const LOGIN = {
  sub: "user_1",
  email: "a@b.com",
  role: "ADMIN" as const,
  permissions: [] as string[],
};

describe("verifyToken — session tokens only", () => {
  it("accepts a real login token and returns its payload", () => {
    const p = verifyToken(signToken(LOGIN));
    expect(p.sub).toBe("user_1");
    expect(p.role).toBe("ADMIN");
  });

  it("accepts an impersonation login token (imp flag, still no kind)", () => {
    const p = verifyToken(signToken({ ...LOGIN, imp: true }));
    expect(p.sub).toBe("user_1");
    expect(p.imp).toBe(true);
  });

  it("REJECTS an unsubscribe token (the account-takeover vector)", () => {
    const unsub = signUnsubscribe("user_1");
    expect(() => verifyToken(unsub)).toThrow();
  });

  it("REJECTS an oauth_state token", () => {
    const state = signState("user_1");
    expect(() => verifyToken(state)).toThrow();
  });

  it("REJECTS a hand-rolled token carrying any kind, even with full session claims", async () => {
    // A signature is not enough: a purpose-scoped token that happens to also
    // carry role/permissions must still be refused at the session boundary.
    const jwt = (await import("jsonwebtoken")).default;
    const forged = jwt.sign({ ...LOGIN, kind: "unsubscribe" }, "test-secret-abcdefgh");
    expect(() => verifyToken(forged)).toThrow();
  });

  it("REJECTS a token signed with the wrong secret", async () => {
    const jwt = (await import("jsonwebtoken")).default;
    const wrong = jwt.sign(LOGIN, "some-other-secret");
    expect(() => verifyToken(wrong)).toThrow();
  });

  it("REJECTS a recording token (can't be used as a login)", () => {
    expect(() => verifyToken(signRecording("call_1", "b_acme", "12h"))).toThrow();
  });
});

describe("recording token", () => {
  it("round-trips the call id and the brand whose database holds it", () => {
    const token = signRecording("call_abc", "b_acme", "12h");
    expect(verifyRecording(token)).toEqual({ callLogId: "call_abc", brandId: "b_acme" });
  });

  it("rejects a token minted for a different purpose", () => {
    // A login or unsubscribe token must never open a recording.
    expect(() => verifyRecording(signToken(LOGIN))).toThrow();
    expect(() => verifyRecording(signUnsubscribe("user_1"))).toThrow();
  });

  it("rejects an expired recording token", async () => {
    const jwt = (await import("jsonwebtoken")).default;
    // Signed 1 hour ago with a 1-second life → long dead.
    const expired = jwt.sign(
      { sub: "call_1", kind: "recording", iat: Math.floor(Date.now() / 1000) - 3600 },
      "test-secret-abcdefgh",
      { expiresIn: "1s" },
    );
    expect(() => verifyRecording(expired)).toThrow();
  });

  it("rejects a wrong-secret recording token", async () => {
    const jwt = (await import("jsonwebtoken")).default;
    const wrong = jwt.sign({ sub: "call_1", kind: "recording" }, "some-other-secret");
    expect(() => verifyRecording(wrong)).toThrow();
  });
});
