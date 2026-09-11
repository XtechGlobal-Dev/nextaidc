import { useCallback, useEffect, useMemo, useState } from "react";
import { clampPage, pageCount, PAGE_SIZE_OPTIONS } from "@/lib/pagination";

export interface UsePaginationOptions {
  /** Records per page on first render. Defaults to the first size option (10). */
  initialPageSize?: number;
  /**
   * Changing this value snaps back to page 1. Pass whatever narrows the list —
   * a search string, a status filter, an active tab — so a filtered result set
   * always opens at its start instead of on a page that no longer exists.
   *
   * Do NOT key this on the row count: rows arriving from a live refresh would
   * yank the reader back to page 1 mid-read. Out-of-range pages are clamped
   * automatically, which covers deletes and shrinking lists.
   */
  resetKey?: unknown;
}

export interface Paginated<T> {
  /** Current page, 1-based and always within range. */
  page: number;
  pageSize: number;
  /** Records on the current page. */
  pageItems: T[];
  /** Records across all pages (i.e. `items.length`). */
  total: number;
  totalPages: number;
  setPage: (page: number) => void;
  /** Changing the page size returns to page 1 — the old offset is meaningless. */
  setPageSize: (size: number) => void;
}

/**
 * Client-side pagination for a list already held in memory.
 *
 * Use this when the whole collection is fetched in one call (most admin lists).
 * For endpoints that page server-side, hold `page`/`pageSize` in local state,
 * send them with the request, and render the same `<Pagination>` control with
 * the server's `total`.
 */
export function usePagination<T>(
  items: T[],
  { initialPageSize = PAGE_SIZE_OPTIONS[0], resetKey }: UsePaginationOptions = {},
): Paginated<T> {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(initialPageSize);

  const total = items.length;
  const totalPages = pageCount(total, pageSize);
  // Derived rather than stored, so the render after a delete never shows a blank
  // page while an effect catches up.
  const current = clampPage(page, total, pageSize);

  // Write the clamped value back so Prev/Next step from where the user actually
  // is (a stale page 9 must not need nine clicks to reach page 2).
  useEffect(() => {
    if (page !== current) setPage(current);
  }, [page, current]);

  useEffect(() => {
    setPage(1);
  }, [resetKey]);

  const pageItems = useMemo(
    () => items.slice((current - 1) * pageSize, current * pageSize),
    [items, current, pageSize],
  );

  const setPageSize = useCallback((size: number) => {
    setPageSizeState(Math.max(1, Math.floor(size) || 1));
    setPage(1);
  }, []);

  return { page: current, pageSize, pageItems, total, totalPages, setPage, setPageSize };
}
