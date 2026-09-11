import { describe, it, expect } from "vitest";
import {
  availableSmsInfoItems,
  buildCombinedSmsBody,
  buildSmsInfoBody,
  clampSms,
  MAX_ENABLED_SMS_INFO_ITEMS,
  SEEDED_SMS_INFO_ITEMS,
  SMS_MAX_LENGTH,
  type SmsInfoItem,
  type SmsInfoValues,
} from "./smsInfoItems.js";

const VALUES: SmsInfoValues = {
  business: "Bright Dental",
  website: "https://brightdental.com.au",
  email: "hello@brightdental.com.au",
  address: "12 Smith St, Perth WA 6000",
  phone: "+61 8 9000 1234",
  hours: "Mon–Fri, 9am–5pm",
};

const item = (over: Partial<SmsInfoItem> = {}): SmsInfoItem => ({
  id: "i1",
  key: "website",
  label: "Website link",
  enabled: true,
  whenToUse: "",
  template: "Our website: {{website}}",
  ...over,
});

describe("clampSms (server authority)", () => {
  it("never exceeds the limit and keeps the link", () => {
    const text =
      "Thanks for calling Bright Dental. Our website: https://brightdental.com.au. " +
      "We look forward to seeing you and hope you have a lovely day ahead of you always and forever.";
    const out = clampSms(text);
    expect(out.length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
    expect(out).toContain("https://brightdental.com.au");
  });

  it("keeps a single over-long sentence rather than dropping it to empty", () => {
    const out = clampSms("supercalifragilistic ".repeat(20));
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
  });
});

describe("buildSmsInfoBody (server authority)", () => {
  it("renders the caller-facing message", () => {
    expect(buildSmsInfoBody(item(), VALUES)).toBe("Our website: https://brightdental.com.au");
  });

  it("won't send when a required detail is missing", () => {
    expect(buildSmsInfoBody(item(), { ...VALUES, website: "" })).toBe("");
  });

  it("keeps every seeded template within a single segment", () => {
    for (const seeded of SEEDED_SMS_INFO_ITEMS) {
      const body = buildSmsInfoBody(seeded, VALUES);
      expect(body).not.toBe("");
      expect(body.length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
    }
  });
});

describe("buildCombinedSmsBody (server authority)", () => {
  it("packs several requested details into a single segment", () => {
    const out = buildCombinedSmsBody(
      [
        item({ key: "website", label: "Website", template: "Site: {{website}}" }),
        item({ key: "email", label: "Email", template: "Email: {{email}}" }),
      ],
      VALUES,
      VALUES.business,
    );
    expect(out.length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
    expect(out).toContain("https://brightdental.com.au");
    expect(out).toContain("hello@brightdental.com.au");
  });

  it("matches the single-item body when only one detail is requested", () => {
    expect(buildCombinedSmsBody([item()], VALUES, VALUES.business)).toBe(
      buildSmsInfoBody(item(), VALUES),
    );
  });

  it("seeds one row per enabled slot, all switched off by default", () => {
    expect(SEEDED_SMS_INFO_ITEMS.length).toBe(MAX_ENABLED_SMS_INFO_ITEMS);
    expect(SEEDED_SMS_INFO_ITEMS.every((i) => i.enabled === false)).toBe(true);
  });
});

describe("availableSmsInfoItems (server authority)", () => {
  it("returns only sendable, enabled, unique-key rows", () => {
    const out = availableSmsInfoItems(
      [
        item({ id: "a", key: "website", label: "First" }),
        item({ id: "b", key: "website", label: "Dup" }),
        item({ id: "c", key: "email", template: "Email {{email}}" }),
        item({ id: "d", key: "off", enabled: false }),
        item({ id: "e", key: "blank", template: "Site {{website}}", ...{} }),
      ],
      { ...VALUES },
    );
    const keys = out.map((e) => e.item.key);
    expect(keys).toContain("website");
    expect(keys).toContain("email");
    expect(keys).not.toContain("off");
    // "website" appears once despite the duplicate.
    expect(keys.filter((k) => k === "website")).toHaveLength(1);
  });
});
