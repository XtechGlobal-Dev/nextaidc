/** Pure paging maths shared by the `<Pagination>` control and `usePagination`.
 *  Kept free of React so both the client-side (slice an array) and server-side
 *  (send page + pageSize to the API) callers can use the same rules. */

/** Record-count choices offered by the "Rows per page" selector. */
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

/** Smaller set for in-card lists (dashboard widgets, detail panels). */
export const COMPACT_PAGE_SIZE_OPTIONS = [5, 10, 25, 50] as const;

/** A slot in the numbered pager: either a page number or an elided run. */
export type PageToken = number | "gap";

/** Total pages for `total` records at `pageSize` per page — never below 1, so an
 *  empty list still reads as "Page 1 of 1" rather than "of 0". */
export function pageCount(total: number, pageSize: number): number {
  const size = Math.max(1, Math.floor(pageSize) || 1);
  return Math.max(1, Math.ceil(Math.max(0, total) / size));
}

/** Clamp a (possibly stale) page number into `1…pageCount`. */
export function clampPage(page: number, total: number, pageSize: number): number {
  const last = pageCount(total, pageSize);
  const n = Math.floor(page);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, last);
}

/** The 1-based record range on the current page — "21–30 of 57", or "0 calls"
 *  when there's nothing to show. `noun` names the records for the empty case. */
export function rangeLabel(
  page: number,
  pageSize: number,
  total: number,
  noun = "records",
): string {
  if (total <= 0) return `0 ${noun}`;
  const size = Math.max(1, Math.floor(pageSize) || 1);
  const current = clampPage(page, total, size);
  const from = (current - 1) * size + 1;
  const to = Math.min(current * size, total);
  return `${from}–${to} of ${total}`;
}

function span(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
}

/** Which page buttons to render, at most `maxButtons` slots wide.
 *
 *  The first and last page are always reachable; a run around the current page
 *  slides between them and anything skipped collapses into a "gap":
 *
 *    pageWindow(1, 10)  → [1, 2, 3, 4, 5, "gap", 10]
 *    pageWindow(5, 10)  → [1, "gap", 4, 5, 6, "gap", 10]
 *    pageWindow(10, 10) → [1, "gap", 6, 7, 8, 9, 10]
 */
export function pageWindow(page: number, totalPages: number, maxButtons = 7): PageToken[] {
  const last = Math.max(1, Math.floor(totalPages) || 1);
  // Below 5 slots there's no room for first + gap + current + gap + last.
  const max = Math.max(5, Math.floor(maxButtons) || 5);
  const current = Math.min(Math.max(1, Math.floor(page) || 1), last);

  if (last <= max) return span(1, last);

  // Slots left for the sliding run once first, last and both gaps are reserved.
  const siblings = Math.max(0, Math.floor((max - 5) / 2));
  const left = Math.max(current - siblings, 1);
  const right = Math.min(current + siblings, last);
  // A gap only pays for itself when it hides more than the page it replaces.
  const gapLeft = left > 3;
  const gapRight = right < last - 2;

  if (gapLeft && gapRight) return [1, "gap", ...span(left, right), "gap", last];
  // Hugging one end: spend the freed gap slot on more real page numbers.
  const run = max - 2;
  if (gapRight) return [...span(1, run), "gap", last];
  if (gapLeft) return [1, "gap", ...span(last - run + 1, last)];
  return span(1, last);
}
