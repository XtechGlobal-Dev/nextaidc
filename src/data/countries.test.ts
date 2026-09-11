import { describe, expect, it } from "vitest";
import { COUNTRIES, isValidPhone, nationalDigits, phoneError } from "./countries";

const byCode = (code: string) => {
  const c = COUNTRIES.find((x) => x.code === code);
  if (!c) throw new Error(`missing country ${code}`);
  return c;
};

describe("isValidPhone", () => {
  it("rejects an Indian number with a leading 0 trunk prefix (the reported bug)", () => {
    expect(isValidPhone("+910828300130")).toBe(false);
  });

  it("accepts a real Indian mobile number", () => {
    expect(isValidPhone("+919876543210")).toBe(true);
  });

  it("accepts a valid US number and rejects a too-short one", () => {
    expect(isValidPhone("+14155552671")).toBe(true);
    expect(isValidPhone("+1415555")).toBe(false);
  });

  it("rejects empty / blank input", () => {
    expect(isValidPhone("")).toBe(false);
    expect(isValidPhone("   ")).toBe(false);
  });
});

describe("nationalDigits", () => {
  it("preserves a leading 0 the user typed for India (no silent trunk stripping)", () => {
    // Within the 10-digit cap the leading 0 must survive (it used to be stripped).
    expect(nationalDigits(byCode("in"), "0987654321")).toBe("0987654321");
  });

  it("preserves a leading 0 the user typed for the UK", () => {
    expect(nationalDigits(byCode("gb"), "0791112345")).toBe("0791112345");
  });

  it("keeps the leading 0 for Italy (it is part of the national number)", () => {
    expect(nationalDigits(byCode("it"), "0612345678")).toBe("0612345678");
  });

  it("drops non-digit characters", () => {
    expect(nationalDigits(byCode("us"), "(415) 555-2671")).toBe("4155552671");
  });

  it("caps the length to the country's max national length (India = 10)", () => {
    expect(nationalDigits(byCode("in"), "1234567890123456789")).toBe("1234567890");
  });
});

describe("phoneError", () => {
  it("returns null for a blank value (callers handle 'required' separately)", () => {
    expect(phoneError("")).toBeNull();
    expect(phoneError("   ")).toBeNull();
  });

  it("returns null for a valid number", () => {
    expect(phoneError("+919876543210")).toBeNull();
    expect(phoneError("+14155552671")).toBeNull();
  });

  it("gives a leading-0 hint when removing the 0 would make it valid (India)", () => {
    const msg = phoneError("+9109876543210");
    expect(msg).toMatch(/leading 0/i);
  });

  it("gives a leading-0 hint for the UK trunk code", () => {
    const msg = phoneError("+4407911123456");
    expect(msg).toMatch(/leading 0/i);
  });

  it("falls back to the generic message for other invalid numbers", () => {
    expect(phoneError("+1415555")).toBe("Enter a valid phone number for the selected country.");
  });
});
