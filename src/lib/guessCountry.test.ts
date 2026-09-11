import { describe, it, expect } from "vitest";
import { guessProfileCountry } from "./guessCountry";

describe("guessProfileCountry", () => {
  it("prefers a country named in the business address", () => {
    expect(guessProfileCountry("42 George St, Sydney NSW 2000, Australia", "+15551234567")).toBe(
      "Australia",
    );
  });

  it("matches a short alias whole-word (USA), not inside another word", () => {
    expect(guessProfileCountry("500 Market St, San Francisco, CA, USA", "")).toBe("United States");
    // "India" must NOT match inside "Indiana".
    expect(guessProfileCountry("Indianapolis, Indiana", "")).not.toBe("India");
  });

  it("takes the country nearest the end when several appear", () => {
    // A UK company with an India office listed first — the address ends in the UK.
    expect(guessProfileCountry("India desk · 10 Downing St, London, United Kingdom", "")).toBe(
      "United Kingdom",
    );
  });

  it("falls back to the mobile's country when the address names none", () => {
    expect(guessProfileCountry("221B Baker Street", "+919876543210")).toBe("India");
    expect(guessProfileCountry("", "+14155550123")).toBe("United States");
  });

  it("returns empty when neither address nor mobile resolves", () => {
    expect(guessProfileCountry("", "")).toBe("");
    expect(guessProfileCountry("just some street", "not a phone")).toBe("");
  });
});
