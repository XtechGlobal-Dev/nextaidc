/** The app-wide plain-date format: dd/mm/yyyy. Use this for any date shown to a
 *  user (emails, notifications, plan-history notes) — never a bare
 *  toLocaleDateString() or an "en-US" format, which render the ambiguous US
 *  m/d/yyyy. Returns "" for a null/invalid input so callers can fall back. */
export function formatDateDMY(value: Date | string | number | null | undefined): string {
  if (value == null || value === "") return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
}
