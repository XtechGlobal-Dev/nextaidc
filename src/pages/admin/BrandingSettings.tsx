import { useEffect, useRef, useState } from "react";
import { Loader2, Image as ImageIcon, Upload, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, ApiError, type Branding, type BrandingSlot, type BrandingState } from "@/lib/api";
import { useBrandingStore } from "@/stores/useBrandingStore";
import { cn } from "@/lib/utils";

const SLOTS: { slot: BrandingSlot; label: string; hint: string; dark?: boolean }[] = [
  { slot: "logoLight", label: "Light-mode logo", hint: "Shown on light backgrounds. PNG/SVG, transparent." },
  { slot: "logoDark", label: "Dark-mode logo", hint: "Use a light-coloured logo — shown on dark backgrounds. Leave empty to auto-lighten your light logo.", dark: true },
  { slot: "favicon", label: "Favicon", hint: "Browser tab icon. PNG or ICO, square (e.g. 32×32)." },
  { slot: "avatarFemale", label: "Onboarding avatar — female voice", hint: "Receptionist photo shown in onboarding when a female voice is picked. Square headshot, PNG/JPG. Leave empty for the built-in default." },
  { slot: "avatarMale", label: "Onboarding avatar — male voice", hint: "Receptionist photo shown in onboarding when a male voice is picked. Square headshot, PNG/JPG. Leave empty for the built-in default." },
];

const ACCEPT = "image/png,image/jpeg,image/webp,image/svg+xml,image/gif,image/x-icon,.ico";

export function BrandingSettings() {
  const [state, setState] = useState<BrandingState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<BrandingSlot | null>(null);
  // Removing an asset applies live immediately — confirm which slot first.
  const [confirmSlot, setConfirmSlot] = useState<BrandingSlot | null>(null);
  const refreshPublic = useBrandingStore((s) => s.refresh);
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => {
    let active = true;
    api.admin.branding
      .get()
      .then((s) => active && setState(s))
      .catch((e) => toast.error(e instanceof ApiError ? e.message : "Failed to load branding"))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  function applyResult(next: BrandingState) {
    setState(next);
    void refreshPublic(); // push new assets to the live app (sidebar logo + favicon)
  }

  async function onPick(slot: BrandingSlot, file: File | undefined) {
    if (!file) return;
    setBusy(slot);
    try {
      applyResult(await api.admin.branding.upload(slot, file));
      toast.success("Branding updated");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Upload failed");
    } finally {
      setBusy(null);
    }
  }

  async function onClear(slot: BrandingSlot) {
    setBusy(slot);
    try {
      applyResult(await api.admin.branding.clear(slot));
      toast.success("Asset removed");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to remove");
    } finally {
      setBusy(null);
    }
  }

  const assets: Branding = state?.assets ?? {
    logoLight: "",
    logoDark: "",
    favicon: "",
    avatarFemale: "",
    avatarMale: "",
  };

  return (
    <Card className="overflow-hidden">
      {/* ---- Header ---- */}
      <div className="border-b border-border bg-card px-4 py-4 sm:px-6 sm:py-5">
        <div className="flex flex-col items-start gap-2.5 sm:flex-row sm:items-center sm:gap-3.5">
          <span className="grid size-12 shrink-0 aspect-square place-items-center rounded-2xl bg-primary/15 text-primary shadow-[inset_0_0_0_1px_hsl(217_84%_55%/0.25)]">
            <ImageIcon className="size-6" />
          </span>
          <div>
            <p className="text-lg font-semibold leading-tight tracking-tight">Branding</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Logos &amp; favicon shown across the app.
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4 p-4 sm:p-6">
        {loading ? (
          <div className="flex h-24 items-center justify-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <>
            {SLOTS.map(({ slot, label, hint, dark }) => {
              const url = assets[slot];
              return (
                <div
                  key={slot}
                  className="lift flex flex-col items-start gap-3 rounded-[var(--radius-card)] border border-border bg-warm/50 p-4 hover:border-primary/30 sm:flex-row sm:items-center sm:gap-4"
                >
                  <div
                    className={cn(
                      "grid size-16 shrink-0 place-items-center overflow-hidden rounded-lg border border-border",
                      dark ? "bg-neutral-900" : "bg-muted",
                    )}
                  >
                    {url ? (
                      <img src={url} alt={label} className="max-h-full max-w-full object-contain" />
                    ) : (
                      <ImageIcon className="size-5 text-muted-foreground" />
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold leading-tight">{label}</p>
                    <p className="text-xs text-muted-foreground">{hint}</p>
                  </div>

                  <input
                    ref={(el) => {
                      inputs.current[slot] = el;
                    }}
                    type="file"
                    accept={ACCEPT}
                    className="hidden"
                    onChange={(e) => {
                      void onPick(slot, e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />

                  <div className="flex shrink-0 items-center gap-2">
                    {url && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-danger hover:bg-danger-tint hover:text-danger"
                        onClick={() => setConfirmSlot(slot)}
                        disabled={busy === slot}
                        aria-label={`Remove ${label}`}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => inputs.current[slot]?.click()}
                      disabled={busy === slot}
                    >
                      {busy === slot ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Upload className="size-4" />
                      )}
                      {url ? "Replace" : "Upload"}
                    </Button>
                  </div>
                </div>
              );
            })}
            <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
              Images up to 5 MB (PNG, JPEG, WebP, SVG, GIF, ICO). Uploads are applied immediately.
            </p>
          </>
        )}
      </div>

      {/* Removal applies live across the app instantly — confirm before deleting. */}
      <Dialog open={!!confirmSlot} onOpenChange={(o) => !o && !busy && setConfirmSlot(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              Remove {SLOTS.find((s) => s.slot === confirmSlot)?.label.toLowerCase() ?? "asset"}?
            </DialogTitle>
            <DialogDescription>
              The image is deleted and the change applies across the app immediately. You'll need
              to upload it again to restore it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmSlot(null)} disabled={!!busy}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={!!busy}
              onClick={async () => {
                if (!confirmSlot) return;
                await onClear(confirmSlot);
                setConfirmSlot(null);
              }}
            >
              {busy === confirmSlot && <Loader2 className="size-4 animate-spin" />}
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
