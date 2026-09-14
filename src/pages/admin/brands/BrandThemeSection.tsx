import { useEffect } from "react";
import { Check, Eye, Type } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { BrandFontOption, BrandThemeCatalog } from "@/lib/api";

/** The theme half of a brand, as the editor holds it while unsaved. */
export interface ThemeDraft {
  themePreset: string;
  primaryColor: string;
  accentColor: string;
  fontFamily: string;
  darkModeDefault: boolean;
}

const GROUP_COPY: Record<BrandFontOption["group"], { label: string; blurb: string }> = {
  business: {
    label: "Business",
    blurb: "Geometric sans — how a software product reads. Crisp at small sizes.",
  },
  classic: {
    label: "Classic",
    blurb: "Serif — how an established firm reads. Warmer, more traditional.",
  },
};

/** Colour + typeface for one brand. Hand-editing a preset flips it to "custom"; the preview is real app chrome so legibility can be judged. */
export function BrandThemeSection({
  catalog,
  value,
  onChange,
  disabled,
}: {
  catalog: BrandThemeCatalog | null;
  value: ThemeDraft;
  onChange: (patch: Partial<ThemeDraft>) => void;
  disabled?: boolean;
}) {
  // Load every catalog face so each option renders in its own typeface; one stylesheet, removed on close.
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

  if (!catalog) {
    return (
      <Card className="p-6">
        <div className="h-4 w-40 animate-pulse rounded bg-muted" />
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      </Card>
    );
  }

  const font =
    catalog.fonts.find((f) => f.id === value.fontFamily) ??
    catalog.fonts.find((f) => f.id === catalog.defaults.font)!;

  const groups: BrandFontOption["group"][] = ["business", "classic"];

  return (
    <div className="space-y-5">
      {/* ------------------------------- Colour ------------------------------ */}
      <Card className="p-5">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-semibold">Colour</h3>
          {value.themePreset === "custom" && <Badge variant="premium">Custom</Badge>}
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          Pick a palette. It sets the brand hue used for buttons, links and active navigation, plus
          a secondary hue for highlights and charts.
        </p>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {catalog.presets.map((p) => {
            const selected = value.themePreset === p.id;
            return (
              <button
                key={p.id}
                type="button"
                disabled={disabled}
                onClick={() =>
                  onChange({
                    themePreset: p.id,
                    primaryColor: p.primary,
                    accentColor: p.accent,
                  })
                }
                className={cn(
                  "group relative overflow-hidden rounded-xl border p-3 text-left transition-all",
                  "focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-50",
                  selected
                    ? "border-primary ring-2 ring-primary/30"
                    : "border-border hover:border-primary/40",
                )}
                aria-pressed={selected}
              >
                <span
                  className="mb-2 block h-10 rounded-lg"
                  style={{ background: `linear-gradient(135deg, ${p.primary}, ${p.accent})` }}
                />
                <span className="flex items-center gap-1 text-sm font-medium">
                  {p.label}
                  {selected && <Check className="size-3.5 text-primary" />}
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                  {p.note}
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <HexField
            id="brand-primary"
            label="Primary"
            hint="Buttons, links, active navigation"
            value={value.primaryColor}
            disabled={disabled}
            onChange={(v) => onChange({ primaryColor: v, themePreset: "custom" })}
          />
          <HexField
            id="brand-accent"
            label="Accent"
            hint="Highlights, badges, second chart series"
            value={value.accentColor}
            disabled={disabled}
            onChange={(v) => onChange({ accentColor: v, themePreset: "custom" })}
          />
        </div>
      </Card>

      {/* -------------------------------- Font ------------------------------- */}
      <Card className="p-5">
        <h3 className="mb-1 text-base font-semibold">Typeface</h3>
        <p className="mb-4 text-sm text-muted-foreground">
          Two families, because they say different things about a business.
        </p>

        <div className="space-y-5">
          {groups.map((group) => (
            <div key={group}>
              <div className="mb-2 flex items-baseline gap-2">
                <span className="inline-flex items-center gap-1.5 text-sm font-medium">
                  <Type className="size-3.5 text-muted-foreground" />
                  {GROUP_COPY[group].label}
                </span>
                <span className="text-xs text-muted-foreground">{GROUP_COPY[group].blurb}</span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {catalog.fonts
                  .filter((f) => f.group === group)
                  .map((f) => {
                    const selected = value.fontFamily === f.id;
                    return (
                      <button
                        key={f.id}
                        type="button"
                        disabled={disabled}
                        onClick={() => onChange({ fontFamily: f.id })}
                        className={cn(
                          "rounded-xl border px-3 py-2.5 text-left transition-all",
                          "focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-50",
                          selected
                            ? "border-primary ring-2 ring-primary/30"
                            : "border-border hover:border-primary/40",
                        )}
                        aria-pressed={selected}
                      >
                        <span
                          className="block truncate text-base font-semibold"
                          style={{ fontFamily: f.stack }}
                        >
                          {f.label}
                        </span>
                        <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                          {f.note}
                        </span>
                      </button>
                    );
                  })}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-5 flex items-center justify-between gap-3 border-t border-border pt-4">
          <div>
            <Label htmlFor="brand-dark" className="text-sm font-medium">
              Open in dark mode
            </Label>
            <p className="text-xs text-muted-foreground">
              First-time visitors to this brand start on the dark theme. They can still switch.
            </p>
          </div>
          <Switch
            id="brand-dark"
            checked={value.darkModeDefault}
            disabled={disabled}
            onCheckedChange={(checked) => onChange({ darkModeDefault: checked })}
          />
        </div>
      </Card>

      {/* ------------------------------- Preview ----------------------------- */}
      <Card className="p-5">
        <h3 className="mb-1 flex items-center gap-1.5 text-base font-semibold">
          <Eye className="size-4 text-muted-foreground" /> Preview
        </h3>
        <p className="mb-4 text-sm text-muted-foreground">
          The same chrome this brand's admins and customers will see.
        </p>
        <ThemePreview theme={value} font={font} />
      </Card>
    </div>
  );
}

function HexField({
  id,
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <div className="mt-1.5 flex items-center gap-2">
        {/* The native swatch is the fast path; the text field is there because a
            brand guideline is handed over as a hex code, not as a colour wheel. */}
        <input
          type="color"
          aria-label={`${label} colour picker`}
          value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : "#000000"}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="size-10 shrink-0 cursor-pointer rounded-lg border border-border bg-background p-1 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <Input
          id={id}
          value={value}
          disabled={disabled}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          placeholder="#2C76ED"
          className="font-mono"
        />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

/** A self-contained slice of app chrome painted with the draft theme. Scoped
 *  with inline styles so previewing never touches the live admin's own theme. */
function ThemePreview({ theme, font }: { theme: ThemeDraft; font: BrandFontOption }) {
  const { primaryColor, accentColor } = theme;
  return (
    <div
      className="overflow-hidden rounded-xl border border-border"
      style={{ fontFamily: font.stack }}
    >
      <div
        className="flex items-center gap-2 px-4 py-3 text-white"
        style={{ background: `linear-gradient(135deg, ${primaryColor}, ${accentColor})` }}
      >
        <span className="text-sm font-semibold">Your brand</span>
      </div>
      <div className="space-y-3 bg-card p-4">
        <p className="text-base font-semibold">Never miss another call</p>
        <p className="text-sm text-muted-foreground">
          Body text in {font.label}. This is roughly the density a customer reads on the dashboard.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="inline-flex h-9 items-center rounded-xl px-4 text-sm font-medium text-white"
            style={{ backgroundColor: primaryColor }}
          >
            Primary action
          </span>
          <span
            className="inline-flex h-9 items-center rounded-xl border px-4 text-sm font-medium"
            style={{ borderColor: primaryColor, color: primaryColor }}
          >
            Secondary
          </span>
          <span
            className="inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium"
            style={{ backgroundColor: `${accentColor}22`, color: accentColor }}
          >
            Accent badge
          </span>
        </div>
      </div>
    </div>
  );
}
