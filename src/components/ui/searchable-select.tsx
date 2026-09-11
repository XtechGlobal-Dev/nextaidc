import * as React from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Search, Check } from "lucide-react";
import { cn } from "@/lib/utils";

/** Roughly the panel's tallest rendered height (search row + max-h-60 list).
 *  Only used to decide whether to drop down or flip up. */
const PANEL_MAX_H = 300;

/**
 * A searchable single-select dropdown over a flat list of string options — the
 * shared look/behaviour behind the Country and Industry pickers. Values are the
 * option strings themselves (what gets stored). Optional extras:
 *  - `clearLabel`: a top row that clears the selection (value → "") e.g. "Not set".
 *  - `renderFooter`: content under the list (e.g. an "add your own" action); it
 *     receives the current trimmed query and a `close()` that also resets search.
 */
export function SearchableSelect({
  value,
  onChange,
  options,
  id,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  clearLabel,
  emptyText = "No matches.",
  maxLength,
  renderFooter,
}: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  id?: string;
  placeholder?: string;
  searchPlaceholder?: string;
  /** When set, a top row that clears the selection (value → ""). */
  clearLabel?: string;
  emptyText?: string;
  /** Cap the search input length (used by the add-your-own consumer). */
  maxLength?: number;
  renderFooter?: (ctx: { query: string; close: () => void }) => React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const rootRef = React.useRef<HTMLDivElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Where to paint the portalled panel, in viewport coordinates.
  const [pos, setPos] = React.useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
  } | null>(null);

  /** Anchor the panel to the trigger. Flips above when there isn't room below,
   *  so a select near the bottom of the page doesn't open off-screen. */
  const measure = React.useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const flipUp = below < PANEL_MAX_H && r.top > below;
    setPos({
      left: r.left,
      width: r.width,
      ...(flipUp
        ? { bottom: window.innerHeight - r.top + 4 }
        : { top: r.bottom + 4 }),
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
      // The panel is portalled to <body>, so it is NOT inside rootRef — both
      // have to be checked or clicking an option would close before it fires.
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    // Capture phase so the panel follows the trigger when ANY scrolling
    // ancestor moves, not just the window.
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

  const q = query.trim();
  const filtered = q ? options.filter((o) => o.toLowerCase().includes(q.toLowerCase())) : options;
  const close = () => {
    setOpen(false);
    setQuery("");
  };
  const select = (v: string) => {
    onChange(v);
    close();
  };

  const footer = renderFooter?.({ query: q, close });

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") setOpen(false);
    else if (e.key === "Enter" && filtered.length === 1) {
      e.preventDefault();
      select(filtered[0]);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        id={id}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 text-left text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
      >
        <span className={cn("truncate", !value && "text-muted-foreground")}>
          {value || placeholder}
        </span>
        <ChevronDown className="size-4 shrink-0 opacity-60" />
      </button>

      {/* Portalled to <body> on purpose. Every page card carries `animate-rise`,
          whose persisted transform makes each card its own stacking context — an
          absolutely-positioned panel (however high its z-index) would be trapped
          inside its card and painted over by the next one. */}
      {open && pos && createPortal(
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
              maxLength={maxLength}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={searchPlaceholder}
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>

          <ul className="max-h-60 overflow-y-auto p-1" role="listbox">
            {clearLabel && (
              <li>
                <button
                  type="button"
                  role="option"
                  aria-selected={!value}
                  onClick={() => select("")}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-muted",
                    !value && "font-medium",
                  )}
                >
                  <Check className={cn("size-3.5 shrink-0", !value ? "text-primary" : "opacity-0")} />
                  <span className="flex-1 truncate text-muted-foreground">{clearLabel}</span>
                </button>
              </li>
            )}

            {filtered.map((o) => {
              const selected = o.toLowerCase() === value.toLowerCase();
              return (
                <li key={o}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => select(o)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-muted",
                      selected && "font-medium",
                    )}
                  >
                    <Check
                      className={cn("size-3.5 shrink-0", selected ? "text-primary" : "opacity-0")}
                    />
                    <span className="flex-1 truncate">{o}</span>
                  </button>
                </li>
              );
            })}

            {filtered.length === 0 && !footer && (
              <li className="px-3 py-2 text-sm text-muted-foreground">{emptyText}</li>
            )}
          </ul>

          {footer && <div className="border-t border-border p-1">{footer}</div>}
        </div>,
        document.body,
      )}
    </div>
  );
}
