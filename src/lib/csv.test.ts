import { describe, it, expect } from "vitest";
import { toCsv, datedCsvName, type CsvColumn } from "./csv";

/* The escaping is the whole job here. A customer list is untrusted text —
 * commas, quotes, newlines and names that Excel would happily execute. */

interface Row {
  name: string;
  calls: number;
  note?: string | null;
}

const columns: CsvColumn<Row>[] = [
  { header: "Name", value: (r) => r.name },
  { header: "Calls", value: (r) => r.calls },
  { header: "Note", value: (r) => r.note },
];

describe("toCsv", () => {
  it("writes a header row and one row per record", () => {
    const csv = toCsv(columns, [{ name: "Ada", calls: 3, note: "vip" }]);
    expect(csv).toBe('"Name","Calls","Note"\r\n"Ada","3","vip"');
  });

  it("uses CRLF line endings, which is what Excel expects", () => {
    const csv = toCsv(columns, [
      { name: "A", calls: 1 },
      { name: "B", calls: 2 },
    ]);
    expect(csv.split("\r\n")).toHaveLength(3);
  });

  it("keeps a comma inside a field from becoming a new column", () => {
    const csv = toCsv(columns, [{ name: "Snap Car Wash, Perth", calls: 0 }]);
    expect(csv).toContain('"Snap Car Wash, Perth"');
    // Header + one row, not two rows.
    expect(csv.split("\r\n")).toHaveLength(2);
  });

  it("doubles embedded quotes so the field survives a round trip", () => {
    const csv = toCsv(columns, [{ name: 'Bob "The Plumber"', calls: 0 }]);
    expect(csv).toContain('"Bob ""The Plumber"""');
  });

  it("keeps a newline inside a field from splitting the row", () => {
    const csv = toCsv(columns, [{ name: "Line one\nLine two", calls: 0 }]);
    // The only CRLF is the header separator — the embedded \n stays quoted.
    expect(csv.split("\r\n")).toHaveLength(2);
  });

  it("neutralises cells Excel would run as a formula", () => {
    // CSV injection: without the guard, opening the file executes these.
    for (const dangerous of ["=cmd|'/c calc'!A1", "+1+1", "-2+3", "@SUM(A1)"]) {
      const csv = toCsv(columns, [{ name: dangerous, calls: 0 }]);
      expect(csv, dangerous).toContain(`"'${dangerous}"`);
    }
  });

  it("leaves an ordinary leading digit or letter alone", () => {
    const csv = toCsv(columns, [{ name: "61 Plumbing", calls: 0 }]);
    expect(csv).toContain('"61 Plumbing"');
    expect(csv).not.toContain("'61 Plumbing");
  });

  it("renders null and undefined as empty cells, not the words", () => {
    const csv = toCsv(columns, [{ name: "Ada", calls: 0, note: null }]);
    expect(csv).toContain('"Ada","0",""');
    expect(csv).not.toMatch(/null|undefined/);
  });

  it("still emits headers when there are no rows", () => {
    expect(toCsv(columns, [])).toBe('"Name","Calls","Note"');
  });
});

describe("datedCsvName", () => {
  it("stamps the date so repeat exports don't overwrite each other", () => {
    expect(datedCsvName("customers", new Date("2026-07-30T09:15:00Z"))).toBe(
      "customers-2026-07-30.csv",
    );
  });
});
