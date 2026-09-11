import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  PAGE_SIZE_OPTIONS,
  pageCount,
  pageWindow,
  rangeLabel,
  clampPage,
} from "@/lib/pagination";

export interface PaginationProps {
  /** Current page, 1-based. */
  page: number;
  pageSize: number;
  /** Records across every page — `items.length`, or the server's `total`. */
  total: number;
  onPageChange: (page: number) => void;
  /** Omit to hide the "Rows per page" selector (fixed-size lists). */
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: readonly number[];
  /** Names the records in the empty label ("0 calls"). */
  noun?: string;
  /** Blocks every control — e.g. while a server-side page is in flight. */
  disabled?: boolean;
  className?: string;
}

/**
 * The app's one pagination control: jump to any page number, step with
 * Prev/Next, and choose how many records a page holds.
 *
 * Renders nothing when there is nothing to page through, so callers can drop it
 * straight under a table without guarding on the row count. Below `sm` the
 * numbered buttons collapse to a "Page x of y" readout — Prev/Next still work,
 * matching how the tables themselves fall back to cards on mobile.
 */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = PAGE_SIZE_OPTIONS,
  noun = "records",
  disabled = false,
  className,
}: PaginationProps) {
  if (total <= 0) return null;

  const totalPages = pageCount(total, pageSize);
  const current = clampPage(page, total, pageSize);
  const tokens = pageWindow(current, totalPages);

  return (
    <nav
      aria-label="Pagination"
      className={cn(
        "mt-4 flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      {/* Records-per-page + the range this page covers */}
      <div className="flex items-center gap-3">
        {onPageSizeChange && (
          <span className="flex items-center gap-2">
            <span className="hidden whitespace-nowrap sm:inline">Rows per page</span>
            <span className="sm:hidden">Rows</span>
            <Select
              value={String(pageSize)}
              onValueChange={(v) => onPageSizeChange(Number(v))}
              disabled={disabled}
            >
              <SelectTrigger
                aria-label="Records per page"
                className="h-8 w-[4.75rem] px-2.5 text-xs tabular-nums"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pageSizeOptions.map((n) => (
                  <SelectItem key={n} value={String(n)} className="tabular-nums">
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </span>
        )}
        <span className="tabular-nums">{rangeLabel(current, pageSize, total, noun)}</span>
      </div>

      <div className="flex items-center justify-between gap-1 sm:justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(current - 1)}
          disabled={disabled || current <= 1}
          aria-label="Previous page"
        >
          <ChevronLeft className="size-4" />
          <span className="hidden sm:inline">Prev</span>
        </Button>

        {/* Desktop — jump straight to a page number */}
        <div className="hidden items-center gap-1 sm:flex">
          {tokens.map((token, i) =>
            token === "gap" ? (
              <span
                // Both gaps stand for a variable run of pages, so index is the
                // only stable key available here.
                key={`gap-${i}`}
                aria-hidden="true"
                className="px-1 select-none"
              >
                …
              </span>
            ) : (
              <Button
                key={token}
                variant={token === current ? "primary" : "ghost"}
                size="sm"
                className="size-8 px-0 tabular-nums"
                aria-label={`Page ${token}`}
                aria-current={token === current ? "page" : undefined}
                onClick={() => onPageChange(token)}
                disabled={disabled}
              >
                {token}
              </Button>
            ),
          )}
        </div>

        {/* Mobile — no room for the number strip */}
        <span className="text-xs tabular-nums sm:hidden">
          Page {current} of {totalPages}
        </span>

        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(current + 1)}
          disabled={disabled || current >= totalPages}
          aria-label="Next page"
        >
          <span className="hidden sm:inline">Next</span>
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </nav>
  );
}
