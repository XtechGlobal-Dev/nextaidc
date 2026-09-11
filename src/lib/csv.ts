/* ------------------------------------------------------------------ *
 *  CSV export — spreadsheet downloads without a spreadsheet library.
 *
 *  Excel opens CSV natively, so a real .xlsx writer (and ~1MB of
 *  dependency) buys nothing for a plain table of rows.
 * ------------------------------------------------------------------ */

/** One output column: a header and how to read it off a row. */
export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
}

/**
 * Characters that make Excel treat a cell as a formula.
 *
 * A customer called "=cmd" or a business named "+61 Plumbing" would otherwise be
 * evaluated when the file is opened — the CSV-injection problem. Prefixing with
 * an apostrophe forces Excel to read the cell as text.
 */
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

/**
 * Trigger a browser download of `csv` as `filename`.
 *
 * The leading BOM matters: without it Excel reads the file as the local ANSI
 * codepage and mangles every accented name.
 */
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
