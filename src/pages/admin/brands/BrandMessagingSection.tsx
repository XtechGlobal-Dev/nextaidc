import { useEffect, useState } from "react";
import { Loader2, Mail, MessageCircle, MessageSquareText, RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, ApiError, type BrandIntegrationView } from "@/lib/api";
import type { LucideIcon } from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  email: Mail,
  twilio: MessageSquareText,
  whatsapp: MessageCircle,
};

/** Brand sending identity (mail, SMS, WhatsApp). Every row shows own-value vs inherited — a "white-label" brand still mailing from the platform address is the failure to surface. */
export function BrandMessagingSection({ brandId }: { brandId: string }) {
  const [views, setViews] = useState<BrandIntegrationView[] | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState<BrandIntegrationView | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const list = await api.super.brands.integrations(brandId);
        if (active) setViews(list);
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : "Failed to load brand messaging");
        if (active) setViews([]);
      }
    })();
    return () => {
      active = false;
    };
  }, [brandId]);

  async function save(view: BrandIntegrationView) {
    // Every field is masked, so send only what was actually typed — untouched
    // fields keep whatever the brand already had (or keep inheriting).
    const updates: Record<string, string> = {};
    for (const f of view.fields) {
      const val = draft[f.key] ?? "";
      if (val.trim()) updates[f.key] = val;
    }
    if (Object.keys(updates).length === 0) {
      toast.message("Nothing to save — type a value into a field first.");
      return;
    }
    setBusy(view.id);
    try {
      const next = await api.super.brands.saveIntegrations(brandId, updates);
      setViews(next);
      setDraft((d) => {
        const cleared = { ...d };
        for (const key of Object.keys(updates)) delete cleared[key];
        return cleared;
      });
      toast.success(`${view.name} updated for this brand`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to save");
    } finally {
      setBusy(null);
    }
  }

  async function reset(view: BrandIntegrationView) {
    setBusy(view.id);
    try {
      setViews(await api.super.brands.clearIntegration(brandId, view.id));
      toast.success(`${view.name} now uses the platform's settings`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to reset");
    } finally {
      setBusy(null);
      setConfirmReset(null);
    }
  }

  if (views === null) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="p-5">
            <div className="h-4 w-40 animate-pulse rounded bg-muted" />
            <div className="mt-4 h-10 animate-pulse rounded bg-muted" />
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Leave a field blank and this brand sends through the platform's own account. Fill it in and
        the brand's customers get mail and messages from the brand instead — which is what makes the
        white label hold up beyond the screen.
      </p>

      {views.map((view) => {
        const Icon = ICONS[view.id] ?? Mail;
        const working = busy === view.id;
        return (
          <Card key={view.id} className="p-5">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-tint text-primary">
                  <Icon className="size-4" />
                </span>
                <div>
                  <p className="flex items-center gap-2 font-medium">
                    {view.name}
                    {view.overridden ? (
                      <Badge variant="success">White-labelled</Badge>
                    ) : (
                      <Badge variant="neutral">Using platform</Badge>
                    )}
                  </p>
                  <p className="text-sm text-muted-foreground">{view.description}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {view.fields.some((f) => f.isSet) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={working}
                    onClick={() => setConfirmReset(view)}
                  >
                    <RotateCcw className="size-4" /> Use platform
                  </Button>
                )}
                <Button size="sm" disabled={working} onClick={() => void save(view)}>
                  {working ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                  Save
                </Button>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              {view.fields.map((f) => {
                const id = `brand-${view.id}-${f.key}`;
                const Field = f.secret ? PasswordInput : Input;
                return (
                  <div key={f.key}>
                    <Label htmlFor={id} className="flex flex-wrap items-center gap-1.5">
                      {f.label}
                      {f.inherited ? (
                        <span className="text-[11px] font-normal text-muted-foreground">
                          — inherited
                        </span>
                      ) : (
                        <span className="text-[11px] font-normal text-success">
                          — set ({f.value})
                        </span>
                      )}
                    </Label>
                    <Field
                      id={id}
                      className="mt-1.5"
                      autoComplete="off"
                      placeholder={f.inherited ? f.placeholder || "Using the platform value" : f.value}
                      value={draft[f.key] ?? ""}
                      onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                    />
                  </div>
                );
              })}
            </div>
          </Card>
        );
      })}

      <Dialog open={confirmReset !== null} onOpenChange={(open) => !open && setConfirmReset(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Use the platform's {confirmReset?.name}?</DialogTitle>
            <DialogDescription>
              This brand's own {confirmReset?.name} credentials are deleted and it goes back to
              sending through the platform's account. Its customers will start seeing the platform's
              sender again. This can't be undone — you'd have to re-enter the credentials.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmReset(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={busy !== null}
              onClick={() => confirmReset && void reset(confirmReset)}
            >
              {busy !== null && <Loader2 className="size-4 animate-spin" />}
              Use platform settings
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
