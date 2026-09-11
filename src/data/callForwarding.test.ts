import { describe, it, expect } from "vitest";
import {
  activateCode,
  buildForwarding,
  buildGsmCodeTable,
  carrierDocLinks,
  codeTableHasCheck,
  CARRIER_DOC_LINKS,
  defaultForwardingCountry,
  findCarrier,
  formatDestination,
  dialDestination,
  isForeignDestination,
  internationalPrefix,
  FORWARDING_COUNTRIES,
} from "./callForwarding";

const AU = "+61 412 345 678"; // parses to +61412345678
const US = "+1 (555) 010-0100"; // parses to +15550100100

describe("buildForwarding — AU / GSM", () => {
  it("all mode → unconditional *21* code with the full international number", () => {
    const r = buildForwarding(AU, "au", "telstra", "all");
    expect(r.activate).toEqual([{ label: "Forward all calls", code: "*21*+61412345678#" }]);
    expect(r.cancel).toEqual([{ label: "Turn forwarding off", code: "#21#" }]);
    expect(r.steps.some((s) => s.includes("*21*+61412345678#"))).toBe(true);
  });

  it("overflow mode → conditional no-answer/busy/unreachable codes + cancel-all", () => {
    const r = buildForwarding(AU, "au", "optus", "overflow");
    expect(r.activate.map((c) => c.code)).toEqual([
      "*61*+61412345678#",
      "*67*+61412345678#",
      "*62*+61412345678#",
    ]);
    expect(r.cancel).toEqual([{ label: "Turn all off", code: "##002#" }]);
  });

  it("surfaces the landline caveat for the AU 'other' carrier", () => {
    const r = buildForwarding(AU, "au", "other-au", "all");
    expect(r.note).toMatch(/landline/i);
  });
});

describe("buildForwarding — US / CLASS codes", () => {
  it("all mode → *72 + domestic 1+national number, cancel *73", () => {
    const r = buildForwarding(US, "us", "us-generic", "all");
    expect(r.activate).toEqual([{ label: "Forward all calls", code: "*7215550100100" }]);
    expect(r.cancel).toEqual([{ label: "Turn forwarding off", code: "*73" }]);
  });

  it("overflow mode → busy *90 + unanswered *92, with off codes", () => {
    const r = buildForwarding(US, "us", "us-generic", "overflow");
    expect(r.activate.map((c) => c.code)).toEqual(["*9015550100100", "*9215550100100"]);
    expect(r.cancel.map((c) => c.code)).toEqual(["*91", "*93"]);
  });
});

describe("buildForwarding — generic GSM", () => {
  it("uses the international number in standard GSM codes", () => {
    const r = buildForwarding(AU, "generic", "gsm", "all");
    expect(r.activate[0].code).toBe("*21*+61412345678#");
    expect(r.note).toMatch(/most mobile networks/i);
  });

  it("forwarding a US number via GSM keeps it international (+1…)", () => {
    const r = buildForwarding(US, "generic", "gsm", "all");
    expect(r.activate[0].code).toBe("*21*+15550100100#");
  });
});

describe("formatting edge cases", () => {
  it("falls back gracefully for an unparseable number (keeps digits, adds +)", () => {
    const r = buildForwarding("0412 345 678", "au", "telstra", "all");
    // Not internationally parseable → still produces a usable-looking code.
    expect(r.activate[0].code).toMatch(/^\*21\*\+\d+#$/);
  });
});

describe("defaultForwardingCountry", () => {
  it("maps calling codes to the right bucket", () => {
    expect(defaultForwardingCountry("+61412345678")).toBe("au");
    expect(defaultForwardingCountry("+15550100100")).toBe("us");
    expect(defaultForwardingCountry("+447911123456")).toBe("generic");
    expect(defaultForwardingCountry("")).toBe("au");
    expect(defaultForwardingCountry(null)).toBe("au");
  });
});

describe("buildGsmCodeTable", () => {
  it("GSM: every scenario, activate split around the number, with ##/*# off/check", () => {
    const rows = buildGsmCodeTable("gsm");
    expect(rows.map((r) => r.scenario)).toEqual([
      "All calls",
      "No answer",
      "Unreachable",
      "Busy",
      "Turn all off",
    ]);
    const all = rows.find((r) => r.scenario === "All calls")!;
    expect(all).toMatchObject({
      activate: { prefix: "**21*", suffix: "#" },
      deactivate: "##21#",
      check: "*#21#",
    });
    // The full dialable code splices the number between prefix and suffix.
    expect(activateCode(all, "+61412345678")).toBe("**21*+61412345678#");
    expect(rows.find((r) => r.scenario === "No answer")!.activate).toMatchObject({ prefix: "**61*", suffix: "#" });
    expect(rows.find((r) => r.scenario === "Unreachable")!.activate).toMatchObject({ prefix: "**62*", suffix: "#" });
    expect(rows.find((r) => r.scenario === "Busy")!.activate).toMatchObject({ prefix: "**67*", suffix: "#" });
    // The "turn all off" row has no activate code, and clears everything at once.
    const off = rows.find((r) => r.scenario === "Turn all off")!;
    expect(off).toMatchObject({ activate: null, deactivate: "##002#", check: "" });
    expect(activateCode(off, "+61412345678")).toBeNull();
  });

  it("Telstra: activate codes carry the voice class *11 (per Telstra's docs)", () => {
    const rows = buildGsmCodeTable("gsm", "telstra");
    const all = rows.find((r) => r.scenario === "All calls")!;
    expect(all.activate).toMatchObject({ prefix: "**21*", suffix: "*11#" });
    expect(activateCode(all, "+61412345678")).toBe("**21*+61412345678*11#");
    // Turn-off / check are unchanged — only the activate sequence gets *11.
    expect(all).toMatchObject({ deactivate: "##21#", check: "*#21#" });
    expect(rows.find((r) => r.scenario === "Busy")!.activate).toMatchObject({ prefix: "**67*", suffix: "*11#" });
    // Non-Telstra carriers keep the plain "#".
    expect(buildGsmCodeTable("gsm", "optus").find((r) => r.scenario === "All calls")!.activate).toMatchObject({
      suffix: "#",
    });
  });

  it("US: CLASS codes, domestic number, no unreachable row and no check column", () => {
    const rows = buildGsmCodeTable("us");
    expect(rows.map((r) => r.scenario)).toEqual(["All calls", "No answer", "Busy"]);
    const all = rows.find((r) => r.scenario === "All calls")!;
    expect(all.activate).toMatchObject({ prefix: "*72", suffix: "" });
    expect(activateCode(all, formatDestination(US, "us"))).toBe("*7215550100100");
    expect(rows.find((r) => r.scenario === "Busy")!).toMatchObject({
      activate: { prefix: "*90", suffix: "" },
      deactivate: "*91",
      check: "",
    });
    expect(codeTableHasCheck("us")).toBe(false);
    expect(codeTableHasCheck("gsm")).toBe(true);
  });
});

describe("carrierDocLinks", () => {
  it("returns curated links for a known country, case-insensitively", () => {
    expect(carrierDocLinks("au").map((l) => l.label)).toContain("Telstra");
    expect(carrierDocLinks("AU").length).toBe(carrierDocLinks("au").length);
    expect(carrierDocLinks("in").map((l) => l.label)).toContain("Jio");
  });

  it("returns an empty list for an unknown / missing country", () => {
    expect(carrierDocLinks("zz")).toEqual([]);
    expect(carrierDocLinks(undefined)).toEqual([]);
    expect(carrierDocLinks(null)).toEqual([]);
  });

  it("every curated link is a valid https URL", () => {
    for (const links of Object.values(CARRIER_DOC_LINKS)) {
      for (const l of links) {
        expect(l.label.length).toBeGreaterThan(0);
        expect(l.url).toMatch(/^https:\/\/.+/);
      }
    }
  });
});

describe("catalog integrity", () => {
  it("every carrier resolves and has a code family", () => {
    for (const country of FORWARDING_COUNTRIES) {
      for (const carrier of country.carriers) {
        const found = findCarrier(country.id, carrier.id);
        expect(found.id).toBe(carrier.id);
        expect(["gsm", "us"]).toContain(found.family);
      }
    }
  });

  it("findCarrier falls back to the first carrier for an unknown id", () => {
    const c = findCarrier("au", "does-not-exist");
    expect(c.id).toBe("telstra");
  });
});

describe("dialDestination", () => {
  it("uses the local form when the AI number is in the country being dialled from", () => {
    // A landline keypad has no "+", and the code is a domestic call either way.
    expect(dialDestination("+61468159801", "au")).toBe("0468159801");
    expect(dialDestination("+61468159801", "AU")).toBe("0468159801");
  });

  it("splices cleanly into a forwarding code", () => {
    const [row] = buildGsmCodeTable("gsm", "telstra");
    expect(activateCode(row, dialDestination("+61468159801", "au"))).toBe("**21*0468159801*11#");
  });

  it("keeps international form for a cross-border number, which has no local form here", () => {
    expect(dialDestination("+61468159801", "gb")).toBe("+61468159801");
    expect(dialDestination("+61468159801", undefined)).toBe("+61468159801");
  });

  it("survives an unassigned / unparseable number", () => {
    expect(dialDestination("", "au")).toBe("+");
  });
});

describe("isForeignDestination", () => {
  it("is true only when the AI number's country differs from the dialling country", () => {
    expect(isForeignDestination("+61468159801", "au")).toBe(false);
    expect(isForeignDestination("+61468159801", "nz")).toBe(true);
    expect(isForeignDestination("+61468159801", undefined)).toBe(false);
    expect(isForeignDestination("not a number", "au")).toBe(false);
  });
});

describe("internationalPrefix", () => {
  it("gives each offered country its own dial-out prefix", () => {
    expect(internationalPrefix("au")).toBe("0011");
    expect(internationalPrefix("US")).toBe("011");
    expect(internationalPrefix("gb")).toBe("00");
  });

  it("falls back to 00 for anything else", () => {
    expect(internationalPrefix("de")).toBe("00");
    expect(internationalPrefix(undefined)).toBe("00");
  });
});
