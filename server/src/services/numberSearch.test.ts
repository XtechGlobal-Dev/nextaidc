import { describe, it, expect, vi, beforeEach } from "vitest";

// searchNumbersByPattern anchors Twilio's loose `contains` itself. Gotchas: "start"
// must skip the dial code (+6*1* isn't a leading 1), and disabled series must stay hidden.

const list = vi.fn();

vi.mock("twilio", () => ({
  default: () => ({
    availablePhoneNumbers: () => ({
      local: { list: (p: unknown) => list("local", p) },
      mobile: { list: (p: unknown) => list("mobile", p) },
    }),
  }),
}));

vi.mock("../env.js", () => ({
  // Brand hosts resolve against these; the real module exports them, so a
  // mock that omits them fails to link for anything importing brandUrls.
  platformDomain: "hello22.ai",
  platformDomains: ["hello22.ai"],
  allowUnverifiedBrandDomains: false,
  canonicalApiBaseUrl: "https://api.test",
  env: { twilioAccountSid: "AC_test", twilioAuthToken: "tok", twilioFromNumber: "+15550000000" },
}));

vi.mock("../prisma.js", () => ({ prisma: {} }));

vi.mock("./settings.js", () => ({
  // sms() builds its client from these and rejects a SID that isn't "AC…".
  getEffective: (key: string) =>
    key === "twilio.accountSid" ? "AC_test_sid" : key === "twilio.authToken" ? "tok" : "",
  integrationsStatus: () => ({ twilio: true }),
}));

import { searchNumbersByPattern } from "./sms.js";

/** Twilio rows for the given E.164 numbers. */
const rows = (...numbers: string[]) =>
  numbers.map((number) => ({ phoneNumber: number, locality: "", region: "" }));

beforeEach(() => list.mockReset());

describe("searchNumbersByPattern", () => {
  it("keeps only numbers ENDING with the digits for 'end'", async () => {
    list.mockImplementation((kind: string) =>
      kind === "local" ? rows("+61861201111", "+61386317999") : rows(),
    );
    expect(await searchNumbersByPattern("AU", "1111", "end", 20)).toEqual(["+61861201111"]);
  });

  it("keeps numbers with the digits anywhere for 'anywhere'", async () => {
    list.mockImplementation((kind: string) =>
      kind === "local"
        ? rows("+61861201111", "+61311119999", "+61399998888")
        : rows(),
    );
    // Match at the end, in the middle, and a number with no 1111 at all.
    expect(await searchNumbersByPattern("AU", "1111", "anywhere", 20)).toEqual([
      "+61861201111",
      "+61311119999",
    ]);
  });

  it("anchors 'start' to the NATIONAL number, not the dial code", async () => {
    // +61 8… starts with 8 nationally. The "1" inside +6[1] must not count as a
    // national-leading digit, or every AU number would match a search for "1".
    list.mockImplementation((kind: string) =>
      kind === "local" ? rows("+61861201111", "+61386317000") : rows(),
    );
    expect(await searchNumbersByPattern("AU", "8", "start", 20)).toEqual(["+61861201111"]);
    list.mockClear();
    expect(await searchNumbersByPattern("AU", "1", "start", 20)).toEqual([]);
  });

  it("searches BOTH inventories — an AU mobile search must not come back empty", async () => {
    list.mockImplementation((kind: string) =>
      kind === "mobile" ? rows("+61468159801") : rows(),
    );
    expect(await searchNumbersByPattern("AU", "9801", "end", 20)).toEqual(["+61468159801"]);
    expect(list.mock.calls.map((c) => c[0]).sort()).toEqual(["local", "mobile"]);
  });

  it("respects the admin's allowed series", async () => {
    list.mockImplementation((kind: string) =>
      kind === "local" ? rows("+61861201111") : rows("+61461201111"),
    );
    // Only "04" (mobile) allowed → the +61 8 local match is dropped.
    expect(
      await searchNumbersByPattern("AU", "1111", "end", 20, { allowedPrefixes: ["04"] }),
    ).toEqual(["+61461201111"]);
  });

  it("applies digits AND prefix together", async () => {
    list.mockImplementation((kind: string) =>
      // Only the "03" series should survive, even though both end in 1111.
      kind === "local" ? rows("+61386311111", "+61286311111") : rows(),
    );
    expect(
      await searchNumbersByPattern("AU", "1111", "end", 20, { prefix: "03" }),
    ).toEqual(["+61386311111"]);
  });

  it("queries only the prefix's inventory, not both", async () => {
    list.mockImplementation(() => rows("+61461201111"));
    await searchNumbersByPattern("AU", "1111", "end", 20, { prefix: "04" });
    // "04" is the AU mobile series — searching `local` as well would be wasted work.
    expect(list.mock.calls.map((c) => c[0])).toEqual(["mobile"]);
  });

  it("dedupes and caps to the requested limit", async () => {
    list.mockImplementation(() => rows("+61861201111", "+61861201111", "+61871111111"));
    const out = await searchNumbersByPattern("AU", "1111", "end", 1);
    expect(out).toHaveLength(1);
  });

  it("returns nothing for a blank search rather than the whole catalogue", async () => {
    expect(await searchNumbersByPattern("AU", "  ", "anywhere", 20)).toEqual([]);
    expect(list).not.toHaveBeenCalled();
  });

  it("survives one inventory erroring (not every country has both)", async () => {
    list.mockImplementation((kind: string) => {
      if (kind === "mobile") throw new Error("no mobile pool in this country");
      return rows("+61861201111");
    });
    expect(await searchNumbersByPattern("AU", "1111", "end", 20)).toEqual(["+61861201111"]);
  });
});
