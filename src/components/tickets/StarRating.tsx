import { useState } from "react";
import { Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { MAX_STARS } from "@/types/ticket";

/* ------------------------------------------------------------------ *
 *  Stars, in two moods: something you set, and something you read.
 *
 *  The interactive one is real buttons rather than a row of icons with
 *  a click handler — a rating has to be reachable by keyboard, and each
 *  star needs its own label ("3 stars") for anyone not looking at it.
 * ------------------------------------------------------------------ */

const SIZE = {
  sm: "size-3.5",
  md: "size-5",
  lg: "size-8",
} as const;

export interface StarRatingProps {
  /** Current score, 1-5, or null when unrated. */
  value: number | null;
  /** Omit to render read-only. */
  onChange?: (value: number) => void;
  size?: keyof typeof SIZE;
  disabled?: boolean;
  className?: string;
}

export function StarRating({
  value,
  onChange,
  size = "md",
  disabled = false,
  className,
}: StarRatingProps) {
  // Hover preview, so the row fills up under the pointer before committing.
  const [hover, setHover] = useState<number | null>(null);
  const readOnly = !onChange;
  const shown = hover ?? value ?? 0;

  return (
    <div
      className={cn("inline-flex items-center gap-0.5", className)}
      role={readOnly ? "img" : "radiogroup"}
      aria-label={
        readOnly
          ? value
            ? `Rated ${value} out of ${MAX_STARS}`
            : "Not rated"
          : "Rate this request"
      }
      onMouseLeave={() => setHover(null)}
    >
      {Array.from({ length: MAX_STARS }, (_, i) => i + 1).map((star) => {
        const filled = star <= shown;
        const icon = (
          <Star
            className={cn(
              SIZE[size],
              "transition-colors",
              filled ? "fill-warning text-warning" : "text-muted-foreground/35",
            )}
          />
        );

        if (readOnly) return <span key={star}>{icon}</span>;

        return (
          <button
            key={star}
            type="button"
            role="radio"
            aria-checked={value === star}
            aria-label={`${star} ${star === 1 ? "star" : "stars"}`}
            disabled={disabled}
            onMouseEnter={() => setHover(star)}
            onFocus={() => setHover(star)}
            onBlur={() => setHover(null)}
            onClick={() => onChange(star)}
            className={cn(
              "rounded-full p-0.5 transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-60",
              !disabled && "cursor-pointer",
            )}
          >
            {icon}
          </button>
        );
      })}
    </div>
  );
}

/** Compact "4.6 ★" for tables and summary tiles. */
export function StarScore({ value, className }: { value: number | null; className?: string }) {
  if (value === null) {
    return <span className={cn("text-xs text-muted-foreground", className)}>—</span>;
  }
  return (
    <span className={cn("inline-flex items-center gap-1 text-sm font-semibold", className)}>
      {value.toFixed(value % 1 === 0 ? 0 : 1)}
      <Star className="size-3.5 fill-warning text-warning" />
    </span>
  );
}
