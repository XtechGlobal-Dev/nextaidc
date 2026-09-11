import { describe, expect, it } from "vitest";
import { getExampleNumber, type CountryCode } from "libphonenumber-js/max";
import examples from "libphonenumber-js/examples.mobile.json";
import { COUNTRIES, isValidPhone, nationalDigits } from "./countries";

type Row = {
  flag: string;
  dial: string;
  sampleNat: string;
  validE164: boolean;
  trunkIn: string;
  trunkNorm: string;
  trunkValid: boolean;
  shortValid: boolean;
  longValid: boolean;
};

const rows: Row[] = [];
const anomalies: string[] = [];

for (const c of COUNTRIES) {
  const cc = c.code.toUpperCase() as CountryCode;
  const ex = getExampleNumber(cc, examples);
  if (!ex) {
    anomalies.push(`${c.code}: no example number in dataset`);
    continue;
  }
  const nat = ex.nationalNumber;
  const e164 = ex.number;

  // 1) The library's own example must validate.
  const validE164 = isValidPhone(e164);

  // 2) Trunk handling: user types a leading 0 in the national field. We preserve
  //    the digits exactly (no silent trunk stripping); validity is decided here.
  const trunkIn = `0${nat}`;
  const trunkNorm = nationalDigits(c, trunkIn);
  const trunkValid = isValidPhone(`+${c.dial}${trunkNorm}`);

  // 3) Obviously-broken lengths should fail. Append 8 digits so even
  //    variable-length plans (Austria, Indonesia) are unambiguously over-length.
  const shortValid = isValidPhone(`+${c.dial}${nat.slice(0, 2)}`);
  const longValid = isValidPhone(`+${c.dial}${nat}00000000`);

  rows.push({
    flag: c.code, dial: c.dial, sampleNat: nat, validE164,
    trunkIn, trunkNorm, trunkValid, shortValid, longValid,
  });

  if (!validE164) anomalies.push(`${c.code}: example ${e164} flagged INVALID`);
  if (shortValid) anomalies.push(`${c.code}: too-short number accepted`);
  if (longValid) anomalies.push(`${c.code}: too-long number accepted`);
}

describe("phone validation — full country matrix", () => {
  it("prints the matrix and finds no anomalies", () => {
    const pad = (s: string, n: number) => s.padEnd(n);
    const header =
      pad("ISO", 4) + pad("+dial", 7) + pad("sample national", 17) +
      pad("E164 ok", 9) + pad("0+nat → norm", 22) + pad("0-ok", 6) +
      pad("short", 7) + "long";
    const lines = rows.map((r) =>
      pad(r.flag, 4) +
      pad(`+${r.dial}`, 7) +
      pad(r.sampleNat, 17) +
      pad(r.validE164 ? "VALID" : "FAIL", 9) +
      pad(`${r.trunkIn}→${r.trunkNorm}`, 22) +
      pad(r.trunkValid ? "ok" : "bad", 6) +
      pad(r.shortValid ? "ACCEPT!" : "reject", 7) +
      (r.longValid ? "ACCEPT!" : "reject"),
    );
    // eslint-disable-next-line no-console
    console.log(
      `\n${header}\n${"-".repeat(header.length)}\n${lines.join("\n")}\n` +
        `\nCountries tested: ${rows.length}` +
        `\nAnomalies: ${anomalies.length ? "\n  - " + anomalies.join("\n  - ") : "none ✅"}\n`,
    );

    // Every library example number must pass our validator.
    expect(rows.every((r) => r.validE164)).toBe(true);
    // No country should accept an obviously too-short or too-long number.
    expect(rows.some((r) => r.shortValid || r.longValid)).toBe(false);
  });

  it("rejects the reported India leading-0 bug across the board", () => {
    expect(isValidPhone("+910828300130")).toBe(false);
  });
});
