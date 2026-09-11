import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Save, Globe, RotateCcw, Trash2, Search, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { COUNTRIES, flagUrl } from "@/data/countries";

/** Display name for an uppercase ISO code, falling back to the code itself. */
function countryName(iso: string): string {
  return COUNTRIES.find((c) => c.code === iso.toLowerCase())?.name ?? iso;
}

/** Small country flag (flagcdn SVG), keyed by uppercase or lowercase ISO code. */
function Flag({ code }: { code: string }) {
  return (
    <img
      src={flagUrl(code.toLowerCase())}
      alt=""
      width={20}
      height={15}
      loading="lazy"
      className="h-[15px] w-5 shrink-0 rounded-[2px] object-cover"
    />
  );
}

/** Searchable dropdown for picking a country to add. The panel is PORTALED to
 *  <body> with fixed positioning so the card's `overflow-hidden` (and the cards
 *  below it) can never clip it — the same approach Radix Select uses. */
function AddCountryPicker({
  options,
  onPick,
  disabled,
}: {
  options: { code: string; name: string }[];
  onPick: (isoUpper: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState<{ left: number; top: number; width: number }>({
    left: 0,
    top: 0,
    width: 256,
  });
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const PANEL_H = 320;
  const place = useCallback(() => {
    const b = btnRef.current?.getBoundingClientRect();
    if (!b) return;
    const width = Math.max(256, b.width);
    // Open downward when there's room, else flip above the button.
    const below = window.innerHeight - b.bottom;
    const top = below >= PANEL_H || below >= b.top ? b.bottom + 4 : b.top - PANEL_H - 4;
    setPos({ left: b.left, top, width });
  }, []);

  function toggle() {
    if (!open) place();
    setOpen((v) => !v);
  }

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    }
    // Keep the panel pinned to the button as the page scrolls/resizes.
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? options.filter((c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q))
      : options;
  }, [options, query]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        onClick={toggle}
        className="flex h-9 w-56 items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 text-sm text-muted-foreground disabled:opacity-50"
      >
        Add a country…
        <ChevronDown className="size-4 shrink-0" />
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            style={{ position: "fixed", left: pos.left, top: pos.top, width: pos.width }}
            className="z-[1200] overflow-hidden rounded-xl border border-border bg-background shadow-[var(--shadow-panel)]"
          >
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <Search className="size-4 shrink-0 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search country"
                className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <ul className="max-h-64 overflow-y-auto p-1">
              {filtered.length === 0 ? (
                <li className="px-3 py-2 text-sm text-muted-foreground">No matches</li>
              ) : (
                filtered.map((c) => (
                  <li key={c.code}>
                    <button
                      type="button"
                      onClick={() => {
                        onPick(c.code.toUpperCase());
                        setOpen(false);
                        setQuery("");
                      }}
                      className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-primary-tint hover:text-primary"
                    >
                      <Flag code={c.code} />
                      <span className="flex-1 truncate">{c.name}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * Admin editor for per-country "regional style" blocks. Each block is appended
 * to a customer's live assistant prompt based on the customer's country, so the
 * assistant sounds local (e.g. an Australian receptionist for AU callers). The
 * built-in defaults ship for the main English-speaking markets; an admin can
 * tweak them or add any other country here.
 */
export function CountryStyleSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [styles, setStyles] = useState<Record<string, string>>({});
  const [builtins, setBuiltins] = useState<Record<string, string>>({});
  // Accordion: only the country being edited is expanded — the list stays short.
  const [openCode, setOpenCode] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.admin.countryStyles
      .get()
      .then((r) => {
        if (!active) return;
        setStyles(r.styles);
        setBuiltins(r.builtins);
      })
      .catch((e) => toast.error(e instanceof ApiError ? e.message : "Failed to load country styles"))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  // All countries in the map (built-ins + admin-added), sorted by display name.
  const codes = useMemo(
    () => Object.keys(styles).sort((a, b) => countryName(a).localeCompare(countryName(b))),
    [styles],
  );

  // Countries not yet in the map — offerable in the "add" dropdown.
  const addable = useMemo(
    () => COUNTRIES.filter((c) => !(c.code.toUpperCase() in styles)),
    [styles],
  );

  function setText(code: string, text: string) {
    setStyles((s) => ({ ...s, [code]: text }));
  }

  function addCountry(code: string) {
    if (!code || code in styles) return;
    setStyles((s) => ({ ...s, [code]: builtins[code] ?? "" }));
  }

  function removeCountry(code: string) {
    setStyles((s) => {
      const next = { ...s };
      delete next[code];
      return next;
    });
  }

  async function save() {
    setSaving(true);
    try {
      const r = await api.admin.countryStyles.set(styles);
      setStyles(r.styles);
      setBuiltins(r.builtins);
      toast.success("Country styles saved", {
        description: "New saves/syncs of each customer's assistant will use them.",
      });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to save country styles");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex items-start justify-between gap-3 border-b border-border bg-card px-4 py-4 sm:px-6 sm:py-5">
        <div className="flex flex-col items-start gap-2.5 sm:flex-row sm:items-center sm:gap-3.5">
          <span className="grid size-12 shrink-0 aspect-square place-items-center rounded-2xl bg-primary/15 text-primary shadow-[inset_0_0_0_1px_hsl(217_84%_55%/0.25)]">
            <Globe className="size-6" />
          </span>
          <div>
            <p className="text-lg font-semibold leading-tight tracking-tight">Regional Style by Country</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Makes each customer's assistant talk like a local for their country.
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4 p-4 sm:p-6">
        <p className="text-sm text-muted-foreground">
          Each block is added to a customer's assistant prompt based on their country — an
          Australian caller hears Aussie phrasing, an American hears American. It shapes word
          choice only (the voice accent comes from the assigned voice), and applies on the
          customer's next save/sync. Leave a country blank to keep it neutral.
        </p>

        {loading ? (
          <div className="flex h-40 items-center justify-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <>
            {/* Accordion — one compact row per country; click to expand and edit. */}
            <div className="space-y-2">
              {codes.map((code) => {
                const isBuiltin = code in builtins;
                const modified = isBuiltin && styles[code].trim() !== (builtins[code] ?? "").trim();
                const isOpen = openCode === code;
                const preview = styles[code].trim().split("\n")[0] || "Neutral — no regional flavour";
                return (
                  <div key={code} className="overflow-hidden rounded-lg border border-border bg-warm">
                    <button
                      type="button"
                      onClick={() => setOpenCode(isOpen ? null : code)}
                      aria-expanded={isOpen}
                      className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-muted/50"
                    >
                      <Flag code={code} />
                      <span className="shrink-0 text-sm font-semibold">{countryName(code)}</span>
                      {isBuiltin ? (
                        modified ? (
                          <Badge variant="primary">Modified</Badge>
                        ) : (
                          <Badge variant="outline">Default</Badge>
                        )
                      ) : (
                        <Badge variant="primary">Custom</Badge>
                      )}
                      <span className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground sm:block">
                        {preview}
                      </span>
                      <ChevronDown
                        className={cn(
                          "ml-auto size-4 shrink-0 text-muted-foreground transition-transform sm:ml-0",
                          isOpen && "rotate-180",
                        )}
                      />
                    </button>
                    {isOpen && (
                      <div className="space-y-2 border-t border-border/60 p-3">
                        <div className="flex justify-end">
                          {isBuiltin ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setText(code, builtins[code])}
                              disabled={saving || !modified}
                              title="Revert this country to its built-in default"
                            >
                              <RotateCcw className="size-4" /> Reset
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-danger hover:bg-danger-tint hover:text-danger"
                              onClick={() => removeCountry(code)}
                              disabled={saving}
                              title="Remove this country's block"
                            >
                              <Trash2 className="size-4" /> Remove
                            </Button>
                          )}
                        </div>
                        <Textarea
                          autoFocus
                          className="min-h-[90px] bg-background font-mono text-xs leading-relaxed"
                          value={styles[code]}
                          onChange={(e) => setText(code, e.target.value)}
                          placeholder="No regional style — the assistant stays neutral for this country."
                          spellCheck={false}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
              <AddCountryPicker options={addable} onPick={addCountry} disabled={saving} />
              <Button size="sm" onClick={save} disabled={saving}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                Save
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
