import { describe, it, expect } from "vitest";
import {
  availableSmsInfoItems,
  buildCombinedSmsBody,
  buildSmsInfoBody,
  clampSms,
  normalizeSmsInfoItems,
  renderSmsTemplate,
  requiredPlaceholders,
  seededSmsInfoItems,
  smsInfoFragment,
  smsInfoKeyFrom,
  EMPTY_SMS_INFO_VALUES,
  MAX_ENABLED_SMS_INFO_ITEMS,
  MAX_SMS_INFO_ITEMS,
  SEEDED_SMS_INFO_ITEMS,
  SMS_MAX_LENGTH,
  type SmsInfoValues,
} from "./smsInfoItems";
import type { SmsInfoItem } from "@/types";

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

describe("renderSmsTemplate", () => {
  it("substitutes every known placeholder", () => {
    expect(renderSmsTemplate("{{business}} — {{website}}", VALUES)).toBe(
      "Bright Dental — https://brightdental.com.au",
    );
  });

  it("renders an unknown placeholder as empty rather than leaving the token", () => {
    expect(renderSmsTemplate("a {{nope}} b", VALUES)).toBe("a  b");
  });

  it("treats a $ in a value as literal text, not a replacement token", () => {
    expect(renderSmsTemplate("{{business}}", { ...VALUES, business: "A$AP Plumbing" })).toBe(
      "A$AP Plumbing",
    );
  });
});

describe("requiredPlaceholders", () => {
  it("lists the placeholders a template depends on", () => {
    expect(requiredPlaceholders("{{website}} and {{email}}").sort()).toEqual(["email", "website"]);
  });

  it("treats {{business}} as decoration, not a requirement", () => {
    expect(requiredPlaceholders("{{business}} website: {{website}}")).toEqual(["website"]);
  });

  it("ignores placeholders that aren't real business details", () => {
    expect(requiredPlaceholders("{{madeup}}")).toEqual([]);
  });
});

describe("clampSms", () => {
  it("leaves a message that already fits untouched", () => {
    expect(clampSms("Short and sweet")).toBe("Short and sweet");
  });

  it("collapses stray whitespace", () => {
    expect(clampSms("a  \n b ")).toBe("a b");
  });

  it("never exceeds the limit", () => {
    const long = `Thank you for calling. ${"Some filler prose. ".repeat(30)}Visit https://example.com/booking`;
    expect(clampSms(long).length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
  });

  it("drops trailing prose but keeps the link", () => {
    const text =
      "Thanks for calling Bright Dental. Our website: https://brightdental.com.au. " +
      "We look forward to seeing you soon and hope you have a wonderful day ahead of you always.";
    const out = clampSms(text);
    expect(out.length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
    expect(out).toContain("https://brightdental.com.au");
    expect(out).not.toContain("wonderful day");
  });

  it("keeps the link intact rather than splitting it mid-way", () => {
    const url = `https://example.com/${"a".repeat(60)}`;
    const out = clampSms(`${"Padding words here. ".repeat(8)}Go to ${url}`);
    expect(out.length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
    // Either the URL survives whole, or it's dropped — never half of it.
    if (out.includes("https://example.com")) expect(out).toContain(url);
  });

  it("falls back to the bare link when even one sentence is too long", () => {
    const url = `https://example.com/${"b".repeat(50)}`;
    const out = clampSms(`${"word ".repeat(40)}${url}`);
    expect(out.length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
    expect(out).toBe(url);
  });

  it("clips a link-free message on a whole-word boundary", () => {
    const out = clampSms("supercalifragilistic ".repeat(20));
    expect(out.length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
    expect(out.endsWith("supercalifragilistic")).toBe(true);
  });
});

describe("buildSmsInfoBody", () => {
  it("renders and returns the message a caller would receive", () => {
    expect(buildSmsInfoBody(item(), VALUES)).toBe("Our website: https://brightdental.com.au");
  });

  it("returns nothing when the business detail it needs is missing", () => {
    expect(buildSmsInfoBody(item(), { ...VALUES, website: "" })).toBe("");
  });

  it("returns nothing for a blank template", () => {
    expect(buildSmsInfoBody(item({ template: "  " }), VALUES)).toBe("");
  });

  it("tidies away the gap a blank business name leaves behind", () => {
    const body = buildSmsInfoBody(
      item({ template: "Thanks for calling {{business}}. Our website: {{website}}" }),
      { ...VALUES, business: "" },
    );
    expect(body).toBe("Thanks for calling. Our website: https://brightdental.com.au");
  });

  it("is always within the SMS limit", () => {
    const body = buildSmsInfoBody(
      item({ template: `{{website}} ${"padding ".repeat(40)}` }),
      VALUES,
    );
    expect(body.length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
  });

  it("keeps every seeded template within the limit for realistic details", () => {
    for (const seeded of SEEDED_SMS_INFO_ITEMS) {
      const body = buildSmsInfoBody(seeded, VALUES);
      expect(body).not.toBe("");
      expect(body.length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
    }
  });
});

describe("availableSmsInfoItems", () => {
  it("skips disabled rows", () => {
    expect(availableSmsInfoItems([item({ enabled: false })], VALUES)).toEqual([]);
  });

  it("skips rows whose message can't render", () => {
    expect(availableSmsInfoItems([item()], { ...VALUES, website: "" })).toEqual([]);
  });

  it("keeps only the first of a duplicated key, so the tool enum stays unambiguous", () => {
    const out = availableSmsInfoItems(
      [item({ id: "a", label: "First" }), item({ id: "b", label: "Second" })],
      VALUES,
    );
    expect(out).toHaveLength(1);
    expect(out[0].item.label).toBe("First");
  });

  it("returns the rendered body alongside each item", () => {
    const [entry] = availableSmsInfoItems([item()], VALUES);
    expect(entry.body).toBe("Our website: https://brightdental.com.au");
  });

  it("handles a missing list", () => {
    expect(availableSmsInfoItems(undefined, VALUES)).toEqual([]);
  });

  it("offers nothing when the business has filled in nothing", () => {
    expect(availableSmsInfoItems(seededSmsInfoItems(), EMPTY_SMS_INFO_VALUES)).toEqual([]);
  });
});

describe("smsInfoFragment", () => {
  it("collapses a single-detail template to Label: value", () => {
    expect(smsInfoFragment(item(), VALUES)).toBe("Website link: https://brightdental.com.au");
  });

  it("keeps a free-text custom message whole", () => {
    expect(smsInfoFragment(item({ template: "Parking is round the back" }), VALUES)).toBe(
      "Parking is round the back",
    );
  });

  it("returns nothing when the detail it needs is missing", () => {
    expect(smsInfoFragment(item(), { ...VALUES, website: "" })).toBe("");
  });
});

describe("buildCombinedSmsBody", () => {
  const web = item({ id: "w", key: "website", label: "Website", template: "Our site: {{website}}" });
  const email = item({ id: "e", key: "email", label: "Email", template: "Email: {{email}}" });

  it("packs several details into one message, business name leading once", () => {
    const out = buildCombinedSmsBody([web, email], VALUES, VALUES.business);
    expect(out).toContain("https://brightdental.com.au");
    expect(out).toContain("hello@brightdental.com.au");
    expect(out.startsWith("Bright Dental —")).toBe(true);
  });

  it("stays within a single segment and keeps both links", () => {
    const out = buildCombinedSmsBody([web, email], VALUES, VALUES.business);
    expect(out.length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
  });

  it("falls back to the normal single-item message for one detail", () => {
    expect(buildCombinedSmsBody([item()], VALUES)).toBe(buildSmsInfoBody(item(), VALUES));
  });

  it("returns nothing for an empty list", () => {
    expect(buildCombinedSmsBody([], VALUES)).toBe("");
  });

  it("drops a detail whose value is missing rather than texting a gap", () => {
    const out = buildCombinedSmsBody([web, email], { ...VALUES, email: "" }, VALUES.business);
    expect(out).toContain("https://brightdental.com.au");
    expect(out).not.toContain("Email:");
  });
});

describe("normalizeSmsInfoItems", () => {
  it("falls back to the seeded catalogue for a config saved before the feature", () => {
    expect(normalizeSmsInfoItems(undefined).map((i) => i.key)).toEqual(
      SEEDED_SMS_INFO_ITEMS.map((i) => i.key),
    );
  });

  it("caps how many rows may be ENABLED, pausing the extras but keeping them", () => {
    const many = Array.from({ length: 5 }, (_, n) => ({ key: `k${n}`, template: `t${n}`, enabled: true }));
    const out = normalizeSmsInfoItems(many);
    expect(out.filter((i) => i.enabled)).toHaveLength(MAX_ENABLED_SMS_INFO_ITEMS);
    // The extras aren't dropped — they're kept as paused rows.
    expect(out.length).toBe(5);
    // The first N stay on; the rest are paused.
    expect(out.slice(0, MAX_ENABLED_SMS_INFO_ITEMS).every((i) => i.enabled)).toBe(true);
    expect(out.slice(MAX_ENABLED_SMS_INFO_ITEMS).every((i) => !i.enabled)).toBe(true);
  });

  it("bounds the total stored rows as a safety cap", () => {
    const tooMany = Array.from({ length: 20 }, (_, n) => ({ key: `k${n}`, template: `t${n}`, enabled: false }));
    expect(normalizeSmsInfoItems(tooMany).length).toBeLessThanOrEqual(MAX_SMS_INFO_ITEMS);
  });

  it("seeds one row per enabled slot, all switched off by default", () => {
    expect(SEEDED_SMS_INFO_ITEMS.length).toBe(MAX_ENABLED_SMS_INFO_ITEMS);
    expect(SEEDED_SMS_INFO_ITEMS.every((i) => i.enabled === false)).toBe(true);
  });

  it("respects an owner who deliberately removed every item", () => {
    expect(normalizeSmsInfoItems([])).toEqual([]);
  });

  it("drops rows with no key or no template — neither can ever send", () => {
    expect(normalizeSmsInfoItems([{ key: "", template: "x" }, { key: "a", template: "" }])).toEqual([]);
  });

  it("drops a duplicate key", () => {
    const out = normalizeSmsInfoItems([
      { key: "a", template: "one" },
      { key: "a", template: "two" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].template).toBe("one");
  });

  it("backfills missing fields", () => {
    const [row] = normalizeSmsInfoItems([{ key: "parking", template: "Round the back" }]);
    expect(row).toMatchObject({ id: "sms_parking", key: "parking", label: "parking", enabled: true });
  });

  it("defaults enabled to true but honours an explicit false", () => {
    expect(normalizeSmsInfoItems([{ key: "a", template: "x", enabled: false }])[0].enabled).toBe(false);
  });
});

describe("seededSmsInfoItems", () => {
  it("hands out a fresh copy so one account can't mutate the shared defaults", () => {
    const first = seededSmsInfoItems();
    first[0].label = "Changed";
    expect(seededSmsInfoItems()[0].label).toBe(SEEDED_SMS_INFO_ITEMS[0].label);
  });
});

describe("smsInfoKeyFrom", () => {
  it("slugifies a label", () => {
    expect(smsInfoKeyFrom("Parking info!", [])).toBe("parking_info");
  });

  it("avoids colliding with a key already in use", () => {
    expect(smsInfoKeyFrom("Parking info", ["parking_info"])).toBe("parking_info_2");
  });

  it("falls back when the label has nothing usable", () => {
    expect(smsInfoKeyFrom("!!!", [])).toBe("item");
  });
});
