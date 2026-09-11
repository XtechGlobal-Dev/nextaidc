import { describe, it, expect, vi, beforeEach } from "vitest";

/* ------------------------------------------------------------------ *
 *  sign_up analytics event. The unique `sign_up` GTM event must fire only when
 *  a NEW account is actually created — not on a failed OTP, and never on a
 *  returning-user login. Runs under jsdom (.test.tsx) so window.dataLayer exists.
 * ------------------------------------------------------------------ */

const h = vi.hoisted(() => ({
  registerVerify: vi.fn(),
  register: vi.fn(),
  login: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    auth: {
      registerVerify: h.registerVerify,
      register: h.register,
      login: h.login,
      me: vi.fn(),
    },
  },
  ApiError: class ApiError extends Error {
    status = 0;
    details: unknown = null;
  },
  setToken: vi.fn(),
  getToken: vi.fn(() => null),
  markSessionActive: vi.fn(),
  TOKEN_KEY: "hello22_token",
}));
vi.mock("@/lib/referral", () => ({ getReferralCode: () => "", clearReferralCode: vi.fn() }));
vi.mock("@/lib/resetUserStores", () => ({ resetUserStores: vi.fn() }));

const { useAuthStore } = await import("@/stores/useAuthStore");

const USER = {
  id: "u1",
  email: "a@b.com",
  fullName: "Test User",
  role: "MEMBER",
  permissions: [],
  profile: { mobile: "+911234567891", businessNumber: "0424102876", address: "12 Main St" },
};
const dl = () =>
  ((window as { dataLayer?: Record<string, unknown>[] }).dataLayer ?? []);
const signUpEvent = () => dl().find((e) => e.event === "sign_up");
const firedSignUp = () => Boolean(signUpEvent());

beforeEach(() => {
  vi.clearAllMocks();
  (window as { dataLayer?: unknown[] }).dataLayer = undefined;
});

describe("sign_up event", () => {
  it("fires after a successful OTP registration, carrying the signup details (no password)", async () => {
    h.registerVerify.mockResolvedValue({ token: "t", user: USER });
    await useAuthStore.getState().registerVerify("a@b.com", "123456");

    const evt = signUpEvent()!;
    expect(evt).toBeTruthy();
    expect(evt.user_id).toBe("u1");
    // Plain values stay as-is.
    expect(evt.user_data).toEqual({
      name: "Test User",
      email: "a@b.com",
      phone: "+911234567891",
      business_number: "0424102876",
      address: "12 Main St",
    });
    // ...and a hashed copy rides alongside for Enhanced Conversions: SHA-256 hex,
    // never the raw value.
    const hashed = evt.user_data_hashed as Record<string, string>;
    expect(hashed.email).toMatch(/^[a-f0-9]{64}$/);
    expect(hashed.phone).toMatch(/^[a-f0-9]{64}$/);
    expect(hashed.name).toMatch(/^[a-f0-9]{64}$/);
    expect(hashed.email).not.toContain("a@b.com");
    // Known SHA-256 of the normalised email, proving it's a real hash.
    const { sha256Hex } = await import("@/lib/analytics");
    expect(hashed.email).toBe(await sha256Hex("a@b.com"));
    // Password must never travel to analytics — plain or hashed.
    expect(JSON.stringify(evt)).not.toMatch(/password/i);
  });

  it("does NOT fire on the direct (non-OTP) register path — signup completes at OTP verify", async () => {
    h.register.mockResolvedValue({ token: "t", user: USER });
    await useAuthStore.getState().register({ email: "a@b.com", password: "pw", fullName: "A" });
    expect(firedSignUp()).toBe(false);
  });

  it("does NOT fire when the OTP verification fails", async () => {
    h.registerVerify.mockRejectedValue(new Error("bad otp"));
    await expect(useAuthStore.getState().registerVerify("a@b.com", "000000")).rejects.toThrow();
    expect(firedSignUp()).toBe(false);
  });

  it("does NOT fire on a returning-user login", async () => {
    h.login.mockResolvedValue({ token: "t", user: USER });
    await useAuthStore.getState().login("a@b.com", "pw");
    expect(firedSignUp()).toBe(false);
  });
});
