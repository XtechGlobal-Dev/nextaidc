const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape HTML-special characters so user input is safe to interpolate into email HTML. */
export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

const NAMED_DECODE: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Decode the common HTML entities that survive when text is pulled straight out
 * of scraped markup (meta descriptions, titles). Handles named entities plus
 * decimal (`&#39;`) and hex (`&#x27;`) numeric refs. Leaves unknown entities
 * untouched. Use on scraped copy before storing/displaying it as plain text.
 */
export function decodeHtml(s: string): string {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, code: string) => {
    const c = code.toLowerCase();
    if (c[0] === "#") {
      const num = c[1] === "x" ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10);
      return Number.isFinite(num) && num > 0 ? String.fromCodePoint(num) : whole;
    }
    return NAMED_DECODE[c] ?? whole;
  });
}
