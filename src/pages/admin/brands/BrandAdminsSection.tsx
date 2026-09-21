import { useEffect, useState } from "react";
import { Loader2, Mail, Plus, UserMinus, UserCog } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, ApiError, type Brand, type BrandAdmin } from "@/lib/api";

/** Brand admins — scoped to their own tenant, never other brands or platform keys. Removing detaches from the brand; the account survives. */
export function BrandAdminsSection({ brand }: { brand: Brand }) {
  const [rows, setRows] = useState<BrandAdmin[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [detaching, setDetaching] = useState<BrandAdmin | null>(null);
  const [form, setForm] = useState({
    email: "",
    fullName: "",
    password: "",
    sendWelcomeEmail: true,
  });

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const list = await api.super.brands.admins(brand.id);
        if (active) setRows(list);
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : "Failed to load brand admins");
        if (active) setRows([]);
      }
    })();
    return () => {
      active = false;
    };
  }, [brand.id]);

  async function add() {
    setSaving(true);
    try {
      const created = await api.super.brands.addAdmin(brand.id, form);
      setRows((prev) => [...(prev ?? []), created]);
      setAdding(false);
      setForm({ email: "", fullName: "", password: "", sendWelcomeEmail: true });
      toast.success(
        created.emailSent
          ? `${created.email} added — credentials emailed.`
          : `${created.email} added. Email wasn't sent, so pass the password on yourself.`,
      );
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to add admin");
    } finally {
      setSaving(false);
    }
  }

  async function detach(user: BrandAdmin) {
    setSaving(true);
    try {
      await api.super.brands.removeAdmin(brand.id, user.id);
      setRows((prev) => (prev ?? []).filter((r) => r.id !== user.id));
      toast.success(`${user.email} removed from ${brand.name}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to remove");
    } finally {
      setSaving(false);
      setDetaching(null);
    }
  }

  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">Brand team</h3>
          <p className="text-sm text-muted-foreground">
            Admins and staff who run {brand.name}. They see only this brand's customers — never
            another brand's, and never the platform's integration keys.
          </p>
        </div>
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus className="size-4" /> Add admin
        </Button>
      </div>

      {rows === null ? (
        <div className="space-y-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="h-14 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-8 text-center">
          <UserCog className="mx-auto size-6 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">No one runs this brand yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            Until you add an admin, only you can manage it.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((u) => (
            <div
              key={u.id}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-3"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-tint text-primary">
                <UserCog className="size-4" />
              </span>
              <div className="min-w-[10rem] flex-1">
                <p className="truncate text-sm font-medium">{u.fullName}</p>
                <p className="truncate text-xs text-muted-foreground">{u.email}</p>
              </div>
              <Badge variant={u.role === "ADMIN" ? "primary" : "neutral"}>
                {u.role === "ADMIN" ? "Brand admin" : "Staff"}
              </Badge>
              <Button
                variant="ghost"
                size="icon"
                className="text-danger hover:bg-danger-tint hover:text-danger"
                onClick={() => setDetaching(u)}
                aria-label={`Remove ${u.email} from ${brand.name}`}
              >
                <UserMinus className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Add admin */}
      <Dialog open={adding} onOpenChange={(open) => !open && setAdding(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add an admin to {brand.name}</DialogTitle>
            <DialogDescription>
              They get full control of this brand — its customers, plans, numbers and staff — and
              nothing outside it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="ba-name">Full name</Label>
              <Input
                id="ba-name"
                className="mt-2"
                value={form.fullName}
                onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))}
                placeholder="Jordan Blake"
              />
            </div>
            <div>
              <Label htmlFor="ba-email">Email</Label>
              <Input
                id="ba-email"
                type="email"
                className="mt-2"
                autoComplete="off"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="admin@brand.com"
              />
            </div>
            <div>
              <Label htmlFor="ba-password">Temporary password</Label>
              <PasswordInput
                id="ba-password"
                className="mt-2"
                autoComplete="new-password"
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                placeholder="At least 8 characters"
              />
            </div>
            <div className="flex items-center justify-between gap-3 pt-1">
              <Label htmlFor="ba-email-toggle" className="flex items-center gap-1.5 text-sm">
                <Mail className="size-3.5 text-muted-foreground" /> Email them their credentials
              </Label>
              <Switch
                id="ba-email-toggle"
                checked={form.sendWelcomeEmail}
                onCheckedChange={(checked) => setForm((f) => ({ ...f, sendWelcomeEmail: checked }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button
              disabled={saving || !form.email.trim() || !form.fullName.trim() || form.password.length < 8}
              onClick={() => void add()}
            >
              {saving && <Loader2 className="size-4 animate-spin" />} Add admin
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detach */}
      <Dialog open={detaching !== null} onOpenChange={(open) => !open && setDetaching(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {detaching?.fullName} from {brand.name}?</DialogTitle>
            <DialogDescription>
              This deletes their account. Every account belongs to a brand, so leaving the brand
              means the login goes with it. To bring them back, add them again with a new
              password.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDetaching(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={saving}
              onClick={() => detaching && void detach(detaching)}
            >
              {saving && <Loader2 className="size-4 animate-spin" />} Remove and delete account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
