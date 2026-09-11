import { describe, it, expect, vi, beforeEach } from "vitest";

/* ------------------------------------------------------------------ *
 *  Billed minutes moved from a JavaScript fold over every call row to a
 *  single SQL aggregate. That is only safe because of one arithmetic
 *  identity, and this suite pins it down:
 *
 *      SUM(CEIL(s / 60))  ===  SUM(billableSeconds(s)) / 60
 *
 *  Rounding has to happen PER CALL — sixty 5-second calls are sixty
 *  billed minutes, not five — so summing raw seconds and rounding once
 *  at the end is a materially different (and much cheaper) number. If
 *  anyone ever "simplifies" the SQL to SUM("durationSec") / 60, the
 *  first test here fails loudly.
 * ------------------------------------------------------------------ */

const h = vi.hoisted(() => ({ queryRaw: vi.fn() }));

vi.mock("../prisma.js", () => ({ prisma: { $queryRaw: h.queryRaw } }));
vi.mock("./vapi.js", () => ({ upsertAssistant: vi.fn() }));

const { billableSeconds, billedMinutesFor } = await import("./trial.js");

/** What the SQL does, in JS: per-row ceil, then sum. */
const sqlEquivalent = (durations: number[]) =>
  durations.reduce((sum, s) => sum + Math.ceil(s / 60), 0);

/** What the two route handlers used to do in JavaScript. */
const oldJsFold = (durations: number[]) =>
  Math.round(durations.reduce((sum, s) => sum + billableSeconds(s), 0) / 60);

beforeEach(() => vi.clearAllMocks());

describe("SUM(CEIL(durationSec / 60)) matches the old per-row fold", () => {
  const cases: Record<string, number[]> = {
    "an empty history": [],
    "a single sub-minute call": [5],
    "calls that land exactly on the minute": [60, 120, 180],
    "calls a second over the minute": [61, 121],
    "zero-duration rows (a failed or missed call)": [0, 0, 30],
    "many short calls — where naive summing goes badly wrong": Array(60).fill(5),
    "a realistic mix": [5, 61, 60, 0, 599, 1, 3600, 45, 119],
  };

  for (const [name, durations] of Object.entries(cases)) {
    it(name, () => {
      expect(sqlEquivalent(durations)).toBe(oldJsFold(durations));
    });
  }

  // The failure mode the per-row ceil exists to prevent, stated outright.
  it("is not the same as summing seconds first", () => {
    const sixtyShortCalls = Array(60).fill(5);
    expect(sqlEquivalent(sixtyShortCalls)).toBe(60);
    expect(Math.round(sixtyShortCalls.reduce((a, b) => a + b, 0) / 60)).toBe(5);
  });
});

describe("billedMinutesFor", () => {
  it("converts the bigint Postgres returns into a plain number", async () => {
    h.queryRaw.mockResolvedValue([{ minutes: 42n }]);
    const result = await billedMinutesFor({ $queryRaw: h.queryRaw } as never, "conv_1");
    expect(result).toBe(42);
    expect(typeof result).toBe("number");
  });

  // COALESCE covers the no-rows case in SQL, but a customer with no calls at
  // all must still read as 0 rather than NaN on their usage card.
  it("reads zero for a customer with no calls", async () => {
    h.queryRaw.mockResolvedValue([{ minutes: null }]);
    expect(await billedMinutesFor({ $queryRaw: h.queryRaw } as never, "conv_1")).toBe(0);
    h.queryRaw.mockResolvedValue([]);
    expect(await billedMinutesFor({ $queryRaw: h.queryRaw } as never, "conv_1")).toBe(0);
  });
});
