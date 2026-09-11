import { useRef, useState } from "react";
import { Image as ImageIcon, Loader2, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { api, ApiError, type Brand } from "@/lib/api";
import { cn } from "@/lib/utils";

type Slot = "logoLight" | "logoDark" | "favicon";

const SLOTS: { slot: Slot; label: string; hint: string; dark?: boolean }[] = [
  {
    slot: "logoLight",
    label: "Light-mode logo",
    hint: "Shown on light backgrounds. PNG or SVG with a transparent background.",
  },
  {
    slot: "logoDark",
    label: "Dark-mode logo",
    hint: "A light-coloured mark for dark backgrounds. Leave empty to auto-lighten the light logo.",
    dark: true,
  },
  {
    slot: "favicon",
    label: "Favicon",
    hint: "Browser-tab icon. Square PNG or ICO (e.g. 32×32).",
  },
];

const ACCEPT = "image/png,image/jpeg,image/webp,image/svg+xml,image/gif,image/x-icon,.ico";

const urlFor = (brand: Brand, slot: Slot) =>
  slot === "logoLight" ? brand.logoLightUrl : slot === "logoDark" ? brand.logoDarkUrl : brand.faviconUrl;

/**
 * The brand's marks. Uploaded straight to the same object storage the platform's
 * own branding uses; the URL is what every client renders, so a replacement is
 * live everywhere the moment it finishes.
 */
export function BrandAssetsSection({
  brand,
  onChange,
}: {
  brand: Brand;
  onChange: (next: Brand) => void;
}) {
  const [busy, setBusy] = useState<Slot | null>(null);
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  async function pick(slot: Slot, file: File | undefined) {
    if (!file) return;
    setBusy(slot);
    try {
      onChange(await api.super.brands.uploadAsset(brand.id, slot, file));
      toast.success("Brand asset updated");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Upload failed");
    } finally {
      setBusy(null);
    }
  }

  async function clear(slot: Slot) {
    setBusy(slot);
    try {
      onChange(await api.super.brands.clearAsset(brand.id, slot));
      toast.success("Brand asset removed");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to remove");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="p-5">
      <h3 className="mb-1 text-base font-semibold">Logos & favicon</h3>
      <p className="mb-4 text-sm text-muted-foreground">
        Replaces the platform's marks everywhere this brand's users look — sidebar, login screen and
        browser tab. Anything left empty falls back to the platform's own asset.
      </p>

      <div className="space-y-3">
        {SLOTS.map(({ slot, label, hint, dark }) => {
          const url = urlFor(brand, slot);
          const working = busy === slot;
          return (
            <div
              key={slot}
              className="flex flex-wrap items-center gap-4 rounded-xl border border-border p-3"
            >
              <div
                className={cn(
                  "flex h-16 w-28 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border",
                  dark ? "bg-foreground/90" : "bg-warm",
                )}
              >
                {url ? (
                  <img src={url} alt={label} className="max-h-12 max-w-24 object-contain" />
                ) : (
                  <ImageIcon className="size-5 text-muted-foreground" />
                )}
              </div>

              <div className="min-w-[12rem] flex-1">
                <p className="text-sm font-medium">{label}</p>
                <p className="text-xs text-muted-foreground">{hint}</p>
              </div>

              <div className="flex items-center gap-2">
                <input
                  ref={(el) => {
                    inputs.current[slot] = el;
                  }}
                  type="file"
                  accept={ACCEPT}
                  className="hidden"
                  onChange={(e) => {
                    void pick(slot, e.target.files?.[0]);
                    e.target.value = ""; // let the same file be re-picked after a failure
                  }}
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={working}
                  onClick={() => inputs.current[slot]?.click()}
                >
                  {working ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                  {url ? "Replace" : "Upload"}
                </Button>
                {url && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-danger hover:bg-danger-tint hover:text-danger"
                    disabled={working}
                    onClick={() => void clear(slot)}
                    aria-label={`Remove ${label}`}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
