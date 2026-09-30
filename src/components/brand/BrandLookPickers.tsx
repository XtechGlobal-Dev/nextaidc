import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  BookOpen,
  Briefcase,
  Check,
  ChevronRight,
  Image as ImageIcon,
  Moon,
  Sun,
  Upload,
  X,
} from "lucide-react";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { BrandColorPreset, BrandFontOption, BrandThemeCatalog } from "@/lib/api";
import { readableInk } from "@/lib/brandTheme";
import { cn } from "@/lib/utils";

// A brand's look — palette, typeface and marks — as pickers. Shared by the super admin's create wizard
// and the public "Set up your brand" form, so an applicant chooses from exactly what the platform offers
// and what they chose lands in the wizard unchanged.

/** What the admin wizard accepts for a logo. */
export const LOGO_ACCEPT = "image/png,image/jpeg,image/webp,image/svg+xml";
/** What the public form accepts: raster only (see the server's PUBLIC_LOGO_TYPES). */
export const PUBLIC_LOGO_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
export const FAVICON_EXTRA_ACCEPT = ",image/x-icon,.ico";

/** A blob URL for a picked file, revoked when it's replaced or the page closes. */
export function useObjectUrl(file: File | null): string {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!file) {
      setUrl("");
      return;
    }
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url;
}

/** Loads every catalog face so the typeface picker shows each option set in the face it actually is.
 *  One stylesheet, removed when the page closes. */
export function useCatalogFonts(catalog: BrandThemeCatalog | null): void {
  useEffect(() => {
    if (!catalog) return;
    const families = catalog.fonts
      .map((f) => f.googleFamily)
      .filter(Boolean)
      .map((name) => `family=${name.replace(/ /g, "+")}:wght@400;600`);
    if (!families.length) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?${families.join("&")}&display=swap`;
    document.head.appendChild(link);
    return () => link.remove();
  }, [catalog]);
}

/* -------------------------------- Palette ------------------------------- */

/** The palette grid: four headline presets, then the rest with a "show every palette" affordance. */
export function PalettePicker({
  presets,
  value,
  onPick,
  expanded = false,
  gridClassName = "sm:grid-cols-2 lg:grid-cols-4",
}: {
  presets: BrandColorPreset[];
  /** The selected preset id. */
  value: string;
  onPick: (preset: BrandColorPreset) => void;
  /** Every palette at once, no "show more" (e.g. inside a dialog). */
  expanded?: boolean;
  /** Column classes for both rows — the default suits a full-width form, not a dialog. */
  gridClassName?: string;
}) {
  const [showAll, setShowAll] = useState(expanded);
  const headline = presets.slice(0, 4);
  const extras = presets.slice(4);
  // A selected palette further down never hides behind the fold.
  const selectedHidden = extras.findIndex((p) => p.id === value) >= 4;
  const visibleExtras = showAll || selectedHidden ? extras : extras.slice(0, 4);

  return (
    <div className="space-y-6">
      <div>
        <Label className="text-sm font-medium">Primary Color</Label>
        <div className={cn("mt-2 grid gap-3", gridClassName)}>
          {headline.map((p) => (
            <PaletteCard key={p.id} preset={p} selected={value === p.id} onSelect={() => onPick(p)} />
          ))}
        </div>
      </div>
      {!!extras.length && (
        <div>
          <Label className="text-sm font-medium">Additional Colors</Label>
          <div className={cn("mt-2 grid gap-3", gridClassName)}>
            {visibleExtras.map((p, i) => (
              <PaletteCard
                key={p.id}
                preset={p}
                selected={value === p.id}
                // The last tile of the collapsed row carries the "there are more" affordance.
                more={
                  i === visibleExtras.length - 1 && extras.length > visibleExtras.length
                    ? () => setShowAll(true)
                    : undefined
                }
                onSelect={() => onPick(p)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PaletteCard({
  preset,
  selected,
  more,
  onSelect,
}: {
  preset: BrandColorPreset;
  selected: boolean;
  /** When set, the tile also offers to reveal the palettes still hidden. */
  more?: () => void;
  onSelect: () => void;
}) {
  return (
    <div
      className={cn(
        "relative flex items-center gap-3 rounded-xl border p-3 transition-all",
        selected ? "border-primary ring-2 ring-primary/25" : "border-border hover:border-primary/40",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:focus-ring"
      >
        <span className="size-6 shrink-0 rounded-full ring-1 ring-black/5" style={{ backgroundColor: preset.primary }} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{preset.label}</span>
          <span className="block truncate font-mono text-[11px] uppercase text-muted-foreground">{preset.primary}</span>
        </span>
        {selected && <Check className="size-4 shrink-0 text-primary" />}
      </button>
      {more && !selected && (
        <button
          type="button"
          onClick={more}
          aria-label="Show every palette"
          className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:focus-ring"
        >
          <ChevronRight className="size-4" />
        </button>
      )}
    </div>
  );
}

/* ------------------------------- Typography ------------------------------ */

/** The typeface select plus the live light/dark specimen in the chosen colours. */
export function TypographyPicker({
  fonts,
  value,
  primary,
  accent,
  onChange,
  id = "b-font",
}: {
  fonts: BrandFontOption[];
  /** The selected font id. */
  value: string;
  primary: string;
  accent: string;
  onChange: (fontId: string) => void;
  id?: string;
}) {
  const font = fonts.find((f) => f.id === value) ?? fonts[0] ?? null;
  return (
    <div className="space-y-5">
      <div className="max-w-sm">
        <Label htmlFor={id} className="text-sm font-medium">
          Font Family
        </Label>
        <div className="mt-2">
          <Select value={font?.id ?? ""} onValueChange={onChange}>
            <SelectTrigger id={id} className="h-10 rounded-xl">
              <SelectValue placeholder="Select a typeface" />
            </SelectTrigger>
            <SelectContent>
              {fonts.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  <span style={{ fontFamily: f.stack }}>{f.label}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          One typeface per brand — used for both headings and body text. Business faces are geometric
          sans; Classic faces are serif.
        </p>
      </div>
      {font && <TypeSpecimen font={font} primary={primary} accent={accent} />}
    </div>
  );
}

const FONT_GROUP: Record<BrandFontOption["group"], { label: string; icon: typeof Briefcase }> = {
  business: { label: "Business", icon: Briefcase },
  classic: { label: "Classic", icon: BookOpen },
};

// Live specimen of app chrome in the chosen font + colours. Shown once per theme: customers pick their
// own, and a colour that reads on white can vanish on the dark surface (and the reverse).
function TypeSpecimen({ font, primary, accent }: { font: BrandFontOption; primary: string; accent: string }) {
  return (
    <div>
      <Label className="text-sm font-medium">Preview</Label>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        Customers choose light or dark for themselves — check the palette reads in both.
      </p>
      <div className="mt-2 grid gap-4 xl:grid-cols-2">
        <SpecimenPane theme="light" font={font} primary={primary} accent={accent} />
        <SpecimenPane theme="dark" font={font} primary={primary} accent={accent} />
      </div>
    </div>
  );
}

function SpecimenPane({
  theme,
  font,
  primary,
  accent,
}: {
  theme: "light" | "dark";
  font: BrandFontOption;
  primary: string;
  accent: string;
}) {
  const group = FONT_GROUP[font.group];
  const GroupIcon = group.icon;
  const dark = theme === "dark";
  const ThemeIcon = dark ? Moon : Sun;
  // Mirror the live app's rule exactly, or the preview would lie: fills keep the brand's
  // literal hex, anything read as text or an outline uses the re-levelled ink.
  const primaryInk = `hsl(${readableInk(primary, theme) ?? primary})`;
  const accentInk = `hsl(${readableInk(accent, theme) ?? accent})`;

  return (
    <div>
      {/* Caption sits OUTSIDE the island, so it stays in the viewer's own theme. */}
      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <ThemeIcon className="size-3.5" />
        {dark ? "Dark mode" : "Light mode"}
      </p>
      {/* The island class repaints surfaces and text only — `primary`/`accent` stay the brand's
          real hex on both. `@container` so the panel lays itself out by its OWN width. */}
      <div className={dark ? "preview-dark" : "preview-light"}>
        <div className="@container relative overflow-hidden rounded-[var(--radius-card)] border border-border bg-background text-foreground">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background: `radial-gradient(120% 140% at 100% 0%, ${primary}17 0%, transparent 55%),
                radial-gradient(90% 120% at 0% 100%, ${accent}14 0%, transparent 60%)`,
            }}
          />
          <SpecimenGlyphs primary={primary} accent={accent} font={font} />

          <span
            className="absolute right-5 top-5 z-10 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold @lg:right-8 @lg:top-7"
            style={{ backgroundColor: `${primary}1a`, color: primaryInk }}
          >
            <GroupIcon className="size-3.5" />
            {group.label}
          </span>

          <div className="relative z-10 px-5 py-7 @lg:px-8 @lg:py-8 @2xl:max-w-[62%]">
            <div className="flex items-center gap-3">
              <span
                className="grid size-11 shrink-0 place-items-center rounded-xl text-lg font-semibold text-white shadow-sm"
                style={{ background: `linear-gradient(135deg, ${primary}, ${accent})` }}
              >
                <span style={{ fontFamily: font.stack }}>Aa</span>
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-semibold">{font.label}</p>
                <p className="truncate text-xs text-muted-foreground">{font.note}</p>
              </div>
            </div>

            <div className="mt-6" style={{ fontFamily: font.stack }}>
              <p className="text-2xl font-bold leading-[1.15] tracking-tight @lg:text-[2rem]">Never miss another call</p>
              <p className="mt-2 max-w-md text-sm text-muted-foreground">
                Body text in {font.label} — roughly the density a customer reads on the dashboard.
              </p>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-2.5">
              <span
                className="inline-flex h-10 items-center gap-1.5 rounded-xl px-4 text-sm font-medium text-white shadow-sm"
                style={{ backgroundColor: primary }}
              >
                Primary action
                <ArrowRight className="size-3.5" />
              </span>
              <span
                className="inline-flex h-10 items-center rounded-xl border-[1.5px] bg-card px-4 text-sm font-medium"
                style={{ borderColor: primaryInk, color: primaryInk }}
              >
                Secondary
              </span>
              <span
                className="inline-flex items-center rounded-full px-3 py-1.5 text-xs font-semibold"
                style={{ backgroundColor: `${accent}22`, color: accentInk }}
              >
                Accent badge
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Decorative "Aa" composition in brand hues. Ornamental only (aria-hidden), dropped in a narrow pane.
function SpecimenGlyphs({ primary, accent, font }: { primary: string; accent: string; font: BrandFontOption }) {
  return (
    // Inset from top/bottom, not `inset-0` — the strip's overflow-hidden hard-clipped the panel shadow at the edge.
    <div aria-hidden className="pointer-events-none absolute inset-x-0 inset-y-8 hidden @2xl:block">
      <div
        className="absolute -right-10 top-1/2 size-56 -translate-y-1/2 rotate-[14deg] rounded-[2rem]"
        style={{
          background: `linear-gradient(135deg, ${primary}33, ${accent}1f)`,
          boxShadow: `0 20px 40px -18px ${primary}40`,
        }}
      />
      <span className="absolute right-16 top-1/2 size-2.5 -translate-y-20 rounded-full" style={{ backgroundColor: accent }} />
      <span className="absolute right-28 top-1/2 size-20 -translate-y-6 rounded-full border-2" style={{ borderColor: `${primary}55` }} />
      <div
        className="absolute right-20 top-1/2 grid size-24 -translate-y-1/2 rotate-[-8deg] place-items-center rounded-2xl bg-card text-3xl font-bold shadow-[var(--shadow-panel)]"
        style={{ color: accent, fontFamily: font.stack }}
      >
        Aa
      </div>
    </div>
  );
}

/* --------------------------------- Marks --------------------------------- */

/** A compact logo/favicon card: click or drop to pick, × to remove. Shows the picked file, or — when
 *  nothing new is picked — an image already uploaded (`existingUrl`, e.g. one sent with a request). */
export function AssetTile({
  label,
  hint,
  file,
  existingUrl = "",
  dark,
  accept = LOGO_ACCEPT + FAVICON_EXTRA_ACCEPT,
  onPick,
}: {
  label: string;
  hint: string;
  file: File | null;
  existingUrl?: string;
  dark?: boolean;
  accept?: string;
  /** null = remove (the picked file and any existing one). */
  onPick: (file: File | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const picked = useObjectUrl(file);
  const url = picked || existingUrl;
  const has = !!file || !!existingUrl;
  const [over, setOver] = useState(false);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onPick(e.dataTransfer.files?.[0] ?? null);
      }}
      className={cn(
        "group relative flex items-center gap-3 rounded-xl border p-3 transition-colors",
        over ? "border-primary bg-primary-tint-soft" : "border-border hover:border-primary/50",
      )}
    >
      <span
        className={cn(
          "grid size-11 shrink-0 place-items-center overflow-hidden rounded-lg border border-border",
          dark ? "bg-foreground/90" : "bg-warm",
        )}
      >
        {url ? (
          <img src={url} alt="" className="max-h-9 max-w-9 object-contain" />
        ) : (
          <ImageIcon className="size-4 text-muted-foreground" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{label}</p>
        <p className="truncate text-xs text-muted-foreground">
          {file ? file.name : existingUrl ? "Uploaded with the request" : hint}
        </p>
      </div>
      <input
        ref={input}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          onPick(e.target.files?.[0] ?? null);
          e.target.value = ""; // let the same file be re-picked after a removal
        }}
      />
      {/* Overlay button, not a wrapper — nesting the Remove button inside would be invalid HTML. */}
      <button
        type="button"
        onClick={() => input.current?.click()}
        aria-label={has ? `Replace ${label}` : `Upload ${label}`}
        className="absolute inset-0 cursor-pointer rounded-xl focus-visible:focus-ring"
      />
      {has ? (
        <button
          type="button"
          onClick={() => onPick(null)}
          aria-label={`Remove ${label}`}
          className="relative grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-danger-tint hover:text-danger focus-visible:focus-ring"
        >
          <X className="size-4" />
        </button>
      ) : (
        // Decorative once the card itself is the button — it would otherwise be a second tab stop.
        <span
          aria-hidden
          className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors group-hover:text-primary"
        >
          <Upload className="size-4" />
        </span>
      )}
    </div>
  );
}

/** The brand's mark as it will appear — the logo, or its initial on the chosen palette until one exists. */
export function BrandMark({
  logoUrl,
  name,
  primary,
  accent,
  className,
}: {
  logoUrl: string;
  name: string;
  primary: string;
  accent: string;
  className?: string;
}) {
  return (
    <span
      className={cn("grid shrink-0 place-items-center overflow-hidden font-semibold text-white", className)}
      style={
        logoUrl
          ? { background: "var(--color-card)", boxShadow: "inset 0 0 0 1px var(--color-border)" }
          : { background: `linear-gradient(135deg, ${primary}, ${accent})` }
      }
    >
      {logoUrl ? <img src={logoUrl} alt="" className="size-full object-contain p-1.5" /> : (name.trim()[0] ?? "B").toUpperCase()}
    </span>
  );
}

export function CatalogSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-16 animate-pulse rounded-xl bg-muted" />
      ))}
    </div>
  );
}

/* ------------------------- Choice buttons + dialogs ---------------------- */
// Colours and logos as a summary button each, opening their own dialog — the form stays short, and what's
// chosen is still visible at a glance. Used by the public request form and the super admin's wizard.

/** A picker summary: what's chosen now, and a way into the dialog that changes it. */
export function ChoiceButton({
  label,
  value,
  action,
  visual,
  disabled,
  onClick,
}: {
  label: string;
  value: string;
  action: string;
  visual: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group flex items-center gap-3 rounded-xl border border-border bg-card p-3.5 text-left transition-colors hover:border-primary/50 hover:bg-primary-tint-soft focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-60"
    >
      {visual}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block truncate text-xs text-muted-foreground">{value}</span>
      </span>
      <span className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-primary">
        {action}
        <ChevronRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
      </span>
    </button>
  );
}

/** The Colours button and its palette dialog. Picking applies at once, so the page's live preview (and
 *  the mini one in the dialog) repaint while the dialog is still open. */
export function ColoursChoice({
  presets,
  value,
  primary,
  accent,
  brandName,
  logoUrl,
  onPick,
  pendingLabel = "Loading…",
}: {
  /** null while the catalog loads (or when it couldn't) — the button is disabled then. */
  presets: BrandColorPreset[] | null;
  /** The selected preset id. */
  value: string;
  primary: string;
  accent: string;
  brandName: string;
  logoUrl: string;
  onPick: (preset: BrandColorPreset) => void;
  /** What the button says while `presets` is null. */
  pendingLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const label = presets?.find((p) => p.id === value)?.label ?? (value === "custom" ? "Custom" : value);
  return (
    <>
      <ChoiceButton
        label="Colours"
        value={presets ? label : pendingLabel}
        action="Change"
        disabled={!presets}
        onClick={() => setOpen(true)}
        visual={
          <span className="relative flex h-10 w-14 shrink-0 items-center">
            <span className="absolute left-0 size-9 rounded-full ring-2 ring-card" style={{ backgroundColor: primary }} />
            <span className="absolute left-5 size-9 rounded-full ring-2 ring-card" style={{ backgroundColor: accent }} />
          </span>
        }
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Choose colours</DialogTitle>
            <DialogDescription>
              The primary colour is for buttons and links, the accent for highlights. Customers see them
              in both light and dark mode.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/40 p-3">
            <BrandMark
              logoUrl={logoUrl}
              name={brandName}
              primary={primary}
              accent={accent}
              className="size-10 rounded-xl text-sm"
            />
            <p className="min-w-0 flex-1 truncate text-sm font-semibold">{brandName || "Your brand"}</p>
            <span
              className="inline-flex h-8 shrink-0 items-center rounded-lg px-3 text-xs font-medium text-white"
              style={{ backgroundColor: primary }}
            >
              Primary action
            </span>
          </div>
          {presets && (
            <PalettePicker
              presets={presets}
              value={value}
              onPick={onPick}
              expanded
              gridClassName="grid-cols-2 sm:grid-cols-4"
            />
          )}
          <DialogFooter>
            <Button type="button" onClick={() => setOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export type LogoSlot = "logoLight" | "logoDark" | "favicon";

/** The Logos button and its upload dialog: light logo, dark logo, favicon. Each slot shows a picked file,
 *  or one already uploaded (`existing` — e.g. sent with a brand request). */
export function LogosChoice({
  files,
  existing = {},
  onPick,
  accept,
  faviconAccept = accept + FAVICON_EXTRA_ACCEPT,
  lightHint,
  description,
  unavailable,
}: {
  files: Record<LogoSlot, File | null>;
  existing?: Partial<Record<LogoSlot, string>>;
  /** null = remove (the picked file and any existing one). */
  onPick: (slot: LogoSlot, file: File | null) => void;
  accept: string;
  faviconAccept?: string;
  /** Under the light-mode logo: the formats this form takes. */
  lightHint: string;
  description: ReactNode;
  /** When set, uploads can't happen here: the button is disabled and says this instead. */
  unavailable?: string;
}) {
  const [open, setOpen] = useState(false);
  const light = useObjectUrl(files.logoLight) || existing.logoLight || "";
  const dark = useObjectUrl(files.logoDark) || existing.logoDark || "";
  const favicon = useObjectUrl(files.favicon) || existing.favicon || "";
  const shown = [light, dark, favicon].filter(Boolean);

  return (
    <>
      <ChoiceButton
        label="Logos"
        value={unavailable ?? (shown.length ? `${shown.length} of 3 added` : "None yet · optional")}
        action={shown.length ? "Change" : "Upload"}
        disabled={!!unavailable}
        onClick={() => setOpen(true)}
        visual={
          <span className="flex h-10 w-14 shrink-0 items-center">
            {shown.length ? (
              shown.map((url, i) => (
                <span
                  key={url}
                  className="-ml-2 grid size-8 place-items-center overflow-hidden rounded-lg border border-border bg-card first:ml-0"
                  style={{ zIndex: 3 - i }}
                >
                  <img src={url} alt="" className="max-h-6 max-w-6 object-contain" />
                </span>
              ))
            ) : (
              <span className="grid size-10 place-items-center rounded-xl border border-dashed border-border text-muted-foreground">
                <ImageIcon className="size-4" />
              </span>
            )}
          </span>
        }
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload logos</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <AssetTile
              label="Light-mode logo"
              hint={lightHint}
              file={files.logoLight}
              existingUrl={existing.logoLight}
              accept={accept}
              onPick={(file) => onPick("logoLight", file)}
            />
            <AssetTile
              label="Dark-mode logo"
              hint="A light mark for dark backgrounds"
              file={files.logoDark}
              existingUrl={existing.logoDark}
              accept={accept}
              onPick={(file) => onPick("logoDark", file)}
              dark
            />
            <AssetTile
              label="Favicon"
              hint="Square PNG or ICO, 32×32"
              file={files.favicon}
              existingUrl={existing.favicon}
              accept={faviconAccept}
              onPick={(file) => onPick("favicon", file)}
            />
          </div>
          <DialogFooter>
            <Button type="button" onClick={() => setOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
