import { useEffect, useState } from "react";
import { Copy, Loader2, Pencil, Plus, Trash2, Users2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
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
import {
  DataCard,
  DataCardAvatar,
  DataCardHeader,
  DataCardPills,
  DataCardGrid,
  CardField,
} from "@/components/ui/data-card";
import { ConfirmDeleteDialog } from "@/components/ui/ConfirmDeleteDialog";
import { Pagination } from "@/components/ui/pagination";
import { api, ApiError, type Reseller } from "@/lib/api";
import { useLiveTick } from "@/hooks/useLiveData";
import { usePagination } from "@/hooks/usePagination";
import { passwordError } from "@/pages/auth/authSchemas";
import { useAuthStore } from "@/stores/useAuthStore";
import { formatDate } from "@/lib/utils";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Stable stand-in for the pre-load `null`, so paging doesn't re-slice each render. */
const EMPTY_RESELLERS: Reseller[] = [];

type ResellerErrors = {
  fullName?: string;
  email?: string;
  password?: string;
  commissionPercent?: string;
};

function referralLink(code: string | null): string {
  if (!code) return "";
  return `${window.location.origin}/?ref=${code}`;
}

function money(cents: number | undefined | null): string {
  const n = Number.isFinite(cents) ? (cents as number) : 0;
  return `$${(n / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function initials(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

export default function AdminResellersPage() {
  const [rows, setRows] = useState<Reseller[] | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Reseller | null>(null);
  const [form, setForm] = useState({ email: "", fullName: "", password: "", commissionPercent: "" });
  const [errors, setErrors] = useState<ResellerErrors>({});
  const [saving, setSaving] = useState(false);
  const [toDelete, setToDelete] = useState<Reseller | null>(null);

  // Capability gates — ADMIN passes all; STAFF only where the role grants it.
  // Denied buttons are omitted from the DOM (not just hidden) and the mutating
  // handlers no-op as a defensive backstop.
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canCreate = hasPermission("resellers.create");
  const canEdit = hasPermission("resellers.edit");
  const canDelete = hasPermission("resellers.delete");

  // `rows` is null until the first load lands; the hook clamps the page back
  // into range when a delete shrinks the list.
  const {
    page,
    pageSize,
    pageItems: pageRows,
    total,
    setPage,
    setPageSize,
  } = usePagination(rows ?? EMPTY_RESELLERS);

  // Re-runs on each live tick. On a background refresh (liveTick > 0) we keep the
  // existing rows on failure and stay quiet, so a transient error never wipes the
  // table or spams toasts.
  const liveTick = useLiveTick();
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const list = await api.admin.resellers.list();
        if (active) setRows(list);
      } catch (e) {
        if (liveTick === 0) {
          toast.error(e instanceof ApiError ? e.message : "Failed to load resellers");
          if (active) setRows([]);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [liveTick]);

  function openCreate() {
    if (!canCreate) return;
    setEditing(null);
    setForm({ email: "", fullName: "", password: "", commissionPercent: "" });
    setErrors({});
    setDialogOpen(true);
  }
  function openEdit(r: Reseller) {
    if (!canEdit) return;
    setEditing(r);
    setForm({ email: r.email, fullName: r.fullName, password: "", commissionPercent: String(r.commissionPercent) });
    setErrors({});
    setDialogOpen(true);
  }

  /** Update a field and clear its inline error. */
  function setField<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => (e[key as keyof ResellerErrors] ? { ...e, [key]: undefined } : e));
  }

  function validate(): ResellerErrors {
    const next: ResellerErrors = {};
    if (form.fullName.trim().length < 2) next.fullName = "Enter the reseller's full name";

    const pct = parseFloat(form.commissionPercent);
    if (form.commissionPercent.trim() === "" || Number.isNaN(pct) || pct < 0 || pct > 100)
      next.commissionPercent = "Commission must be between 0 and 100";

    // Email + password only collected when creating (not editing).
    if (!editing) {
      if (!form.email.trim()) next.email = "Email is required";
      else if (!EMAIL_RE.test(form.email.trim())) next.email = "Enter a valid email address";
      const pwErr = passwordError(form.password);
      if (pwErr) next.password = pwErr;
    }
    return next;
  }

  function copyLink(r: Reseller) {
    const link = referralLink(r.referralCode);
    if (!link) return;
    void navigator.clipboard.writeText(link);
    toast.success("Referral link copied");
  }

  async function submit() {
    if (editing ? !canEdit : !canCreate) return;
    const found = validate();
    if (Object.keys(found).length > 0) {
      setErrors(found);
      return;
    }
    setErrors({});
    const pct = parseFloat(form.commissionPercent);
    setSaving(true);
    try {
      if (editing) {
        const updated = await api.admin.resellers.update(editing.id, {
          fullName: form.fullName.trim(),
          commissionPercent: pct,
        });
        setRows((prev) => (prev ?? []).map((r) => (r.id === editing.id ? updated : r)));
        toast.success("Reseller updated");
      } else {
        const created = await api.admin.resellers.create({
          email: form.email.trim(),
          fullName: form.fullName.trim(),
          password: form.password,
          commissionPercent: pct,
        });
        setRows((prev) => [created, ...(prev ?? [])]);
        toast.success("Reseller created");
      }
      setDialogOpen(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to save reseller");
    } finally {
      setSaving(false);
    }
  }

  const renderLinkButton = (r: Reseller) => (
    <button
      type="button"
      onClick={() => copyLink(r)}
      className="inline-flex max-w-[180px] items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-xs hover:border-primary/40"
      aria-label="Copy referral link"
    >
      <code className="truncate">{r.referralCode ?? "—"}</code>
      <Copy className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );

  const renderActions = (r: Reseller) => (
    <div className="flex items-center justify-end gap-1">
      {canEdit && (
        <Button variant="ghost" size="icon" onClick={() => openEdit(r)} aria-label={`Edit ${r.fullName}`}>
          <Pencil className="size-4" />
        </Button>
      )}
      {canDelete && (
        <Button
          variant="ghost"
          size="icon"
          className="text-danger hover:bg-danger-tint hover:text-danger"
          onClick={() => setToDelete(r)}
          aria-label={`Delete ${r.fullName}`}
        >
          <Trash2 className="size-4" />
        </Button>
      )}
      {!canEdit && !canDelete && <span className="text-muted-foreground">—</span>}
    </div>
  );

  async function confirmDelete() {
    if (!toDelete || !canDelete) return;
    await api.admin.resellers.remove(toDelete.id);
    setRows((prev) => (prev ?? []).filter((r) => r.id !== toDelete.id));
    toast.success(`${toDelete.fullName} removed`);
  }

  return (
    <div>
      <PageHeader
        title="Resellers"
        subtitle="Partners who refer customers and earn commission on their subscriptions."
        actions={
          canCreate ? (
            <Button onClick={openCreate}>
              <Plus className="size-4" /> New reseller
            </Button>
          ) : undefined
        }
      />

      {rows === null ? (
        <Card className="overflow-hidden">
          <div className="border-b border-border px-4 py-3">
            <div className="h-4 w-32 animate-pulse rounded bg-muted" />
          </div>
          <div className="divide-y divide-border/60">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3.5">
                <div className="size-9 shrink-0 animate-pulse rounded-full bg-muted" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3.5 w-40 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-56 max-w-full animate-pulse rounded bg-muted" />
                </div>
                <div className="h-5 w-12 shrink-0 animate-pulse rounded-full bg-muted" />
                <div className="hidden h-3.5 w-16 shrink-0 animate-pulse rounded bg-muted sm:block" />
                <div className="hidden h-3.5 w-24 shrink-0 animate-pulse rounded bg-muted md:block" />
              </div>
            ))}
          </div>
        </Card>
      ) : rows.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 py-16 text-center">
          <Users2 className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">No resellers yet</p>
          <p className="text-sm text-muted-foreground">Add a partner to start tracking referrals.</p>
          {canCreate && (
            <Button className="mt-2" onClick={openCreate}>
              <Plus className="size-4" /> New reseller
            </Button>
          )}
        </Card>
      ) : (
        <>
          {/* Desktop — table (md and up) */}
          <Card className="hidden overflow-hidden md:block">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Reseller</th>
                    <th className="px-4 py-3 font-medium">Rate</th>
                    <th className="px-4 py-3 text-right font-medium">Referred</th>
                    <th className="px-4 py-3 text-right font-medium">Earned</th>
                    <th className="px-4 py-3 text-right font-medium">Pending</th>
                    <th className="px-4 py-3 font-medium">Referral link</th>
                    <th className="px-4 py-3 font-medium">Joined</th>
                    <th className="px-4 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((r) => (
                    <tr key={r.id} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-tint text-xs font-semibold text-primary">
                            {initials(r.fullName)}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate font-medium">{r.fullName}</p>
                            <p className="truncate text-xs text-muted-foreground">{r.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="primary">{r.commissionPercent}%</Badge>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{r.referredCount}</td>
                      <td className="px-4 py-3 text-right font-medium tabular-nums text-success">
                        {money(r.earnedCents)}
                      </td>
                      <td className="px-4 py-3 text-right font-medium tabular-nums">{money(r.pendingCents)}</td>
                      <td className="px-4 py-3">{renderLinkButton(r)}</td>
                      <td className="px-4 py-3 text-muted-foreground">{formatDate(r.createdAt)}</td>
                      <td className="px-4 py-3">{renderActions(r)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Mobile — cards (below md) */}
          <div className="space-y-3 md:hidden">
            {pageRows.map((r) => (
              <DataCard key={r.id}>
                <DataCardHeader
                  lead={<DataCardAvatar>{initials(r.fullName)}</DataCardAvatar>}
                  title={r.fullName}
                  subtitle={r.email}
                  actions={renderActions(r)}
                />
                <DataCardPills>
                  <Badge variant="primary">{r.commissionPercent}%</Badge>
                </DataCardPills>
                <DataCardGrid>
                  <CardField label="Referred">
                    <span className="tabular-nums">{r.referredCount}</span>
                  </CardField>
                  <CardField label="Earned">
                    <span className="tabular-nums text-success">{money(r.earnedCents)}</span>
                  </CardField>
                  <CardField label="Pending">
                    <span className="tabular-nums">{money(r.pendingCents)}</span>
                  </CardField>
                  <CardField label="Joined">{formatDate(r.createdAt)}</CardField>
                  <div className="col-span-2 min-w-0">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      Referral link
                    </p>
                    <div className="mt-0.5">{renderLinkButton(r)}</div>
                  </div>
                </DataCardGrid>
              </DataCard>
            ))}
          </div>
        </>
      )}

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        noun="resellers"
      />

      {/* Create / edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={(o) => !saving && setDialogOpen(o)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit reseller" : "New reseller"}</DialogTitle>
            <DialogDescription>
              {editing
                ? "Update the reseller's details. Changing the % applies to future commissions."
                : "Create a reseller login. They get a referral link and earn commission on referred customers."}
            </DialogDescription>
          </DialogHeader>

          <form
            id="reseller-form"
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!saving) void submit();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="rs-name">Full name</Label>
              <Input
                id="rs-name"
                value={form.fullName}
                onChange={(e) => setField("fullName", e.target.value)}
                aria-invalid={!!errors.fullName}
                className={errors.fullName ? "border-danger" : undefined}
              />
              {errors.fullName && <p className="text-xs text-danger">{errors.fullName}</p>}
            </div>
            {!editing && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="rs-email">Email (login)</Label>
                  <Input
                    id="rs-email"
                    type="email"
                    value={form.email}
                    onChange={(e) => setField("email", e.target.value)}
                    aria-invalid={!!errors.email}
                    className={errors.email ? "border-danger" : undefined}
                  />
                  {errors.email && <p className="text-xs text-danger">{errors.email}</p>}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="rs-pass">Temporary password</Label>
                  <PasswordInput
                    id="rs-pass"
                    value={form.password}
                    onChange={(e) => setField("password", e.target.value)}
                    aria-invalid={!!errors.password}
                    className={errors.password ? "border-danger" : undefined}
                  />
                  {errors.password ? (
                    <p className="text-xs text-danger">{errors.password}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      8+ characters with uppercase, lowercase &amp; a special character
                    </p>
                  )}
                </div>
              </>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="rs-pct">Commission %</Label>
              <Input
                id="rs-pct"
                type="number"
                min={0}
                max={100}
                step="0.5"
                value={form.commissionPercent}
                onChange={(e) => setField("commissionPercent", e.target.value)}
                aria-invalid={!!errors.commissionPercent}
                className={errors.commissionPercent ? "border-danger" : undefined}
              />
              {errors.commissionPercent && <p className="text-xs text-danger">{errors.commissionPercent}</p>}
            </div>
          </form>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" form="reseller-form" disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              {editing ? "Save changes" : "Create reseller"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <ConfirmDeleteDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        resourceType="reseller"
        resourceName={toDelete?.fullName ?? ""}
        onConfirm={confirmDelete}
        description="This also removes their login access."
      />
    </div>
  );
}
