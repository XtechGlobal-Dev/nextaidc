import { useCallback, useEffect, useMemo, useState } from "react";
import { clampPage, pageCount, PAGE_SIZE_OPTIONS } from "@/lib/pagination";

export interface UsePaginationOptions {
  /** Records per page on first render. Defaults to the first size option (10). */
  initialPageSize?: number;
  /** Changing this snaps to page 1 — pass the search/filter/tab. Do NOT key it on row count:
   *  a live refresh would yank the reader back mid-read; out-of-range pages are clamped anyway. */
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

/** Client-side pagination for an in-memory list. For server-paged endpoints, hold page/pageSize
 *  locally and render the same `<Pagination>` with the server's total. */
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
