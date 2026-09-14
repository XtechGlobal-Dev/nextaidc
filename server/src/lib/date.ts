/** App-wide dd/mm/yyyy for user-facing dates — never bare toLocaleDateString() (ambiguous US m/d).
 *  "" for null/invalid so callers can fall back. */
export function formatDateDMY(value: Date | string | number | null | undefined): string {
  if (value == null || value === "") return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
}
