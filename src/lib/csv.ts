// CSV export. Excel opens CSV natively, so an .xlsx writer (~1MB of dependency) buys nothing here.

/** One output column: a header and how to read it off a row. */
export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
}

/** Leading chars Excel treats as a formula (CSV injection: "+61 Plumbing" would be evaluated). Apostrophe-prefixed to force text. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** Quote one cell for CSV, neutralising anything Excel would run as a formula. */
function cell(value: string | number | null | undefined): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const safe = FORMULA_START.test(raw) ? `'${raw}` : raw;
  // Always quote: names and addresses routinely contain commas and line breaks,
  // and quoting unconditionally is cheaper than deciding per cell.
  return `"${safe.replace(/"/g, '""')}"`;
}

/** Render rows as CSV text. CRLF line endings — what Excel expects. */
export function toCsv<T>(columns: CsvColumn<T>[], rows: T[]): string {
  return [
    columns.map((c) => cell(c.header)).join(","),
    ...rows.map((row) => columns.map((c) => cell(c.value(row))).join(",")),
  ].join("\r\n");
}

/** Download `csv` as `filename`. The BOM matters: without it Excel reads the local ANSI codepage and mangles accents. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** `prefix-2026-07-30.csv` — dated so repeated exports don't overwrite. */
export function datedCsvName(prefix: string, now = new Date()): string {
  return `${prefix}-${now.toISOString().slice(0, 10)}.csv`;
}
