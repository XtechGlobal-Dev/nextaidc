import { useCallback, useEffect, useState } from "react";
import { Building2, Eye, EyeOff, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDeleteDialog } from "@/components/ui/ConfirmDeleteDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { AdminTicketDepartment, BrandTicketDepartmentInput } from "@/types/ticket";

// A brand's support queues, platform side. Which queues exist is the platform's call; who works them is the
// brand admin's (from their inbox) — so this edits the definition, never the staffing.

interface Draft extends Required<BrandTicketDepartmentInput> {
  id: string | null;
}

const EMPTY: Draft = {
  id: null,
  name: "",
  description: "",
  requesterVisible: true,
  enabled: true,
  order: 0,
};

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function BrandDepartmentsSection({ brand }: { brand: { id: string; name: string } }) {
  const [rows, setRows] = useState<AdminTicketDepartment[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [toDelete, setToDelete] = useState<AdminTicketDepartment | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await api.super.brands.ticketDepartments.list(brand.id));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't load departments");
      setRows([]);
    }
  }, [brand.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!draft) return;
    if (draft.name.trim().length < 2) {
      toast.error("Give the department a name");
      return;
    }
    setSaving(true);
    try {
      const payload: BrandTicketDepartmentInput = {
        name: draft.name.trim(),
        description: draft.description.trim(),
        requesterVisible: draft.requesterVisible,
        enabled: draft.enabled,
        order: draft.order,
      };
      if (draft.id) await api.super.brands.ticketDepartments.update(brand.id, draft.id, payload);
      else await api.super.brands.ticketDepartments.create(brand.id, payload);
      toast.success(draft.id ? "Department updated" : `Department added to ${brand.name}`);
      setDraft(null);
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't save the department");
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(d: AdminTicketDepartment) {
    try {
      await api.super.brands.ticketDepartments.update(brand.id, d.id, { enabled: !d.enabled });
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't update the department");
    }
  }

  async function confirmDelete() {
    if (!toDelete) return;
    await api.super.brands.ticketDepartments.remove(brand.id, toDelete.id);
    toast.success(`"${toDelete.name}" deleted`);
    setToDelete(null);
    await load();
  }

  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Building2 className="size-4 text-primary" /> Support departments
          </h3>
          <p className="text-sm text-muted-foreground">
            The queues {brand.name}&apos;s customers file requests into. You decide which exist;
            the brand&apos;s admin decides who works each one. Every brand starts with General
            and Sales.
          </p>
        </div>
        <Button size="sm" className="gap-1.5" onClick={() => setDraft({ ...EMPTY })}>
          <Plus className="size-4" /> Add department
        </Button>
      </div>

      {rows === null ? (
        <div className="space-y-2">
          <Skeleton className="h-16 rounded-xl" />
          <Skeleton className="h-16 rounded-xl" />
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No departments yet. Add one so {brand.name}&apos;s customers have somewhere to file a
          request.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((d) => (
            <li
              key={d.id}
              className={cn(
                "flex items-start gap-3 rounded-xl border border-border bg-card p-3.5 transition-opacity",
                !d.enabled && "opacity-60",
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold leading-tight">{d.name}</p>
                  {d.requesterVisible ? (
                    <Badge variant="outline" className="gap-1 text-[11px] font-medium">
                      <Eye className="size-3" /> Offered
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="gap-1 text-[11px] font-medium text-muted-foreground"
                    >
                      <EyeOff className="size-3" /> Internal only
                    </Badge>
                  )}
                  {!d.enabled && <Badge variant="neutral">Off</Badge>}
                </div>
                {d.description && (
                  <p className="mt-1 text-sm text-muted-foreground">{d.description}</p>
                )}
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {plural(d.ticketCount, "request")}
                  <span className="mx-1.5">•</span>
                  {plural(d.roleCount + d.staffCount, "grant")} by the brand
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2 pt-0.5">
                <Switch
                  checked={d.enabled}
                  onCheckedChange={() => void toggleEnabled(d)}
                  aria-label={`${d.enabled ? "Disable" : "Enable"} ${d.name}`}
                  className="mr-1"
                />
                <button
                  type="button"
                  onClick={() =>
                    setDraft({
                      id: d.id,
                      name: d.name,
                      description: d.description,
                      requesterVisible: d.requesterVisible,
                      enabled: d.enabled,
                      order: d.order,
                    })
                  }
                  className="flex size-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label={`Edit ${d.name}`}
                >
                  <Pencil className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setToDelete(d)}
                  className="flex size-9 items-center justify-center rounded-lg border border-border text-danger transition-colors hover:border-danger/40 hover:bg-danger-tint"
                  aria-label={`Delete ${d.name}`}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={draft !== null} onOpenChange={(o) => !o && !saving && setDraft(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit department" : `New department for ${brand.name}`}</DialogTitle>
            <DialogDescription>
              What the brand&apos;s customers see in their picker. The brand&apos;s admin chooses
              who works it from their inbox.
            </DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
                <div className="space-y-2">
                  <Label htmlFor="brand-dept-name">
                    Name <span className="text-danger">*</span>
                  </Label>
                  <Input
                    id="brand-dept-name"
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    placeholder="e.g. Billing"
                    maxLength={60}
                    autoFocus
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="brand-dept-order">Order</Label>
                  <Input
                    id="brand-dept-order"
                    type="number"
                    min={0}
                    max={999}
                    value={draft.order}
                    onChange={(e) => setDraft({ ...draft, order: Number(e.target.value) || 0 })}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="brand-dept-desc">Description</Label>
                <Input
                  id="brand-dept-desc"
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  placeholder="Shown under the name in the customer's picker"
                  maxLength={200}
                />
              </div>
              <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-border px-4 py-3 text-sm">
                <span>
                  <span className="block font-medium">Offer to customers</span>
                  <span className="block text-xs text-muted-foreground">
                    Off = the team can file into it, but nobody can pick it.
                  </span>
                </span>
                <Switch
                  checked={draft.requesterVisible}
                  onCheckedChange={(v) => setDraft({ ...draft, requesterVisible: v })}
                />
              </label>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              {draft?.id ? "Save changes" : "Add department"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDeleteDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        resourceType="department"
        resourceName={toDelete?.name ?? ""}
        onConfirm={confirmDelete}
        description={
          toDelete?.ticketCount
            ? "This department still has requests — the delete will be rejected. Ask the brand to move them first, or turn the department off instead."
            : "Every role and staff member the brand granted this department will lose it."
        }
      />
    </Card>
  );
}
