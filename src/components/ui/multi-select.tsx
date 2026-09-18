import * as React from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

/** Roughly the panel's tallest rendered height (search row + list + footer).
 *  Only used to decide whether to drop down or flip up. */
const PANEL_MAX_H = 340;

export interface MultiSelectOption {
  value: string;
  label: string;
  /** Secondary line under the label (price, interval…). */
  hint?: string;
}

/** Searchable multi-select: the trigger shows the picks as chips (each removable), the portalled panel
 *  lists every option with a tick. Same anchoring as SearchableSelect so it never opens off-screen. */
export function MultiSelect({
  values,
  onChange,
  options,
  id,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No matches.",
  maxChips = 4,
  disabled,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  options: MultiSelectOption[];
  id?: string;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  /** Chips shown in the trigger before the rest collapse into "+N more". */
  maxChips?: number;
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const rootRef = React.useRef<HTMLDivElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const [pos, setPos] = React.useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
  } | null>(null);

  const measure = React.useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const flipUp = below < PANEL_MAX_H && r.top > below;
    setPos({
      left: r.left,
      width: r.width,
      ...(flipUp ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
    });
  }, []);

  React.useLayoutEffect(() => {
    if (open) measure();
    else setPos(null);
  }, [open, measure]);

  React.useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      // The panel is portalled to <body>, so it is NOT inside rootRef — both have to be checked.
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const reposition = () => measure();
    document.addEventListener("mousedown", onDocClick);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, measure]);

  const byValue = React.useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);
  const picked = new Set(values);
  const q = query.trim().toLowerCase();
  const filtered = q
    ? options.filter(
        (o) => o.label.toLowerCase().includes(q) || (o.hint ?? "").toLowerCase().includes(q),
      )
    : options;

  const toggle = (v: string) =>
    onChange(picked.has(v) ? values.filter((x) => x !== v) : [...values, v]);
  const remove = (v: string) => onChange(values.filter((x) => x !== v));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Enter" && filtered.length === 1) {
      e.preventDefault();
      toggle(filtered[0].value);
    }
  };

  // Chips keep the pick order; unknown values (an option that has since gone) still show by id so they can be removed.
  const chips = values.map((v) => ({ value: v, label: byValue.get(v)?.label ?? v }));
  const shown = chips.slice(0, maxChips);
  const hiddenCount = chips.length - shown.length;
  const allShownSelected = filtered.length > 0 && filtered.every((o) => picked.has(o.value));

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        id={id}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "flex min-h-10 w-full items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 py-1.5 text-left text-sm",
          "focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-60",
        )}
      >
        {chips.length === 0 ? (
          <span className="truncate text-muted-foreground">{placeholder}</span>
        ) : (
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {shown.map((c) => (
              <span
                key={c.value}
                className="inline-flex max-w-full items-center gap-1 rounded-md bg-primary-tint px-2 py-0.5 text-xs font-medium text-primary"
              >
                <span className="truncate">{c.label}</span>
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={`Remove ${c.label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(c.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      remove(c.value);
                    }
                  }}
                  className="rounded-sm hover:bg-primary/15"
                >
                  <X className="size-3" />
                </span>
              </span>
            ))}
            {hiddenCount > 0 && (
              <span className="text-xs text-muted-foreground">+{hiddenCount} more</span>
            )}
          </span>
        )}
        <ChevronDown className="size-4 shrink-0 opacity-60" />
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            style={{ left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom }}
            className="fixed z-[100] overflow-hidden rounded-xl border border-border bg-background shadow-[var(--shadow-panel)]"
          >
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <Search className="size-4 shrink-0 text-muted-foreground" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={searchPlaceholder}
                className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>

            <ul className="max-h-60 overflow-y-auto p-1" role="listbox" aria-multiselectable>
              {filtered.map((o) => {
                const selected = picked.has(o.value);
                return (
                  <li key={o.value}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => toggle(o.value)}
                      className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-muted"
                    >
                      <span
                        className={cn(
                          "grid size-4 shrink-0 place-items-center rounded border",
                          selected ? "border-primary bg-primary text-primary-foreground" : "border-border",
                        )}
                      >
                        {selected && <Check className="size-3" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={cn("block truncate", selected && "font-medium")}>{o.label}</span>
                        {o.hint && (
                          <span className="block truncate text-xs text-muted-foreground">{o.hint}</span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
              {filtered.length === 0 && (
                <li className="px-3 py-2 text-sm text-muted-foreground">{emptyText}</li>
              )}
            </ul>

            <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-1.5 text-xs">
              <span className="text-muted-foreground">
                {values.length} of {options.length} selected
              </span>
              <span className="flex items-center gap-3">
                <button
                  type="button"
                  className="font-medium text-primary hover:underline disabled:opacity-50"
                  disabled={filtered.length === 0 || allShownSelected}
                  onClick={() =>
                    onChange([...values, ...filtered.map((o) => o.value).filter((v) => !picked.has(v))])
                  }
                >
                  Select all
                </button>
                <button
                  type="button"
                  className="font-medium text-muted-foreground hover:underline disabled:opacity-50"
                  disabled={values.length === 0}
                  onClick={() => onChange([])}
                >
                  Clear
                </button>
              </span>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
