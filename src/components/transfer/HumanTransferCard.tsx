import { useEffect, useRef, useState } from "react";
import { Check, PhoneForwarded, Timer, Plus, Trash2, Building2, Pencil, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { PhoneInput } from "@/components/ui/phone-input";
import { cn } from "@/lib/utils";
import { phoneError } from "@/data/countries";
import type { TransferDepartment } from "@/types";
import { useTransferStore } from "@/stores/useTransferStore";

/** Default per-department ring time (seconds) before the AI speaks the end message. */
const DEFAULT_RING_SEC = 15;
const DEFAULT_FALLBACK_MESSAGE =
  "Our team isn't available right now. We've recorded your request and will contact you as soon as possible. Thank you for calling.";

/** Department draft. `uid` is a stable client key: the server id for saved rows, generated for unsaved. */
interface DraftDept {
  uid: string;
  name: string;
  number: string;
  description: string;
  enabled: boolean;
  ringTimeoutSec: number;
  fallbackMessage: string;
}

const toDraft = (departments: TransferDepartment[]): DraftDept[] =>
  departments.map((d) => ({
    uid: d.id,
    name: d.name,
    number: d.number,
    description: d.description,
    enabled: d.enabled,
    ringTimeoutSec: d.ringTimeoutSec,
    fallbackMessage: d.fallbackMessage,
  }));

/** Human Call Transfer card: departments edited via modal, saved immediately. `maxDepartments` only shapes
 *  the UI; the server caps every write, so a stale entitlement can't buy extra departments. */
export function HumanTransferCard({
  className,
  locked = false,
  maxDepartments = Number.POSITIVE_INFINITY,
}: {
  className?: string;
  /** Plan excludes Call Transfer — render read-only with nothing writable. */
  locked?: boolean;
  maxDepartments?: number;
}) {
  const settings = useTransferStore((s) => s.settings);
  const departments = useTransferStore((s) => s.departments);
  const hydrate = useTransferStore((s) => s.hydrate);
  const updateSettings = useTransferStore((s) => s.updateSettings);
  const saveDraft = useTransferStore((s) => s.saveDraft);

  // Local mirror for rendering; every change persists immediately and re-syncs from the store.
  const [draft, setDraft] = useState<DraftDept[]>([]);
  const [saving, setSaving] = useState(false);
  const uidRef = useRef(0);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    setDraft(toDraft(departments));
  }, [departments]);

  // No on/off toggle; keep the master flag on so the tool reaches the live assistant (it only transfers
  // when an enabled department exists).
  useEffect(() => {
    // Skipped while locked: the PATCH is refused without transfer, so mount would surface a 403 toast.
    if (locked) return;
    if (settings && !settings.enabled) void updateSettings({ enabled: true });
  }, [settings, updateSettings, locked]);

  if (!settings) return null;

  // Persist a full department list to the server immediately. Optimistically
  // reflects `next` in the UI; on failure saveDraft re-hydrates, reverting it.
  const persist = async (next: DraftDept[]) => {
    for (const d of next) {
      if (d.number.trim() && phoneError(d.number)) {
        toast.error(`${d.name || "Department"}: ${phoneError(d.number)}`);
        return false;
      }
    }
    setDraft(next);
    setSaving(true);
    try {
      await saveDraft(
        next.map((d) => ({
          name: d.name.trim(),
          number: d.number.trim(),
          description: d.description.trim(),
          enabled: d.enabled,
          ringTimeoutSec: d.ringTimeoutSec,
          fallbackMessage: d.fallbackMessage.trim(),
        })),
        // Keep the legacy single-number settings untouched — waiting time and
        // end message are now per-department.
        { ringTimeoutSec: settings.ringTimeoutSec, fallbackMessage: settings.fallbackMessage },
      );
      return true;
    } catch {
      /* saveDraft already surfaced the error + re-hydrated */
      return false;
    } finally {
      setSaving(false);
    }
  };

  const addRow = (row: {
    name: string;
    number: string;
    description: string;
    ringTimeoutSec: number;
    fallbackMessage: string;
  }) => persist([...draft, { uid: `new-${uidRef.current++}`, enabled: true, ...row }]);
  const updateRow = (uid: string, patch: Partial<DraftDept>) =>
    persist(draft.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
  const removeRow = (uid: string) => persist(draft.filter((r) => r.uid !== uid));

  // "Active" once at least one enabled department has a number to dial.
  const active = draft.some((d) => d.enabled && !!d.number.trim());

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <PhoneForwarded className="size-5 text-primary" />
              Human Call Transfer
            </CardTitle>
            <CardDescription>
              When a caller asks to speak to a real person, the AI asks which department they
              need and transfers the call to that department's number.
            </CardDescription>
          </div>
          {active && (
            <Badge variant="success" className="shrink-0">
              <Check className="size-3" />
              Active
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent>
        {/* Departments — each add/edit/toggle/delete saves immediately. */}
        <DepartmentsSection
          draft={draft}
          saving={saving}
          locked={locked}
          maxDepartments={maxDepartments}
          onAdd={addRow}
          onUpdate={updateRow}
          onRemove={removeRow}
        />
      </CardContent>
    </Card>
  );
}

interface DepartmentsSectionProps {
  draft: DraftDept[];
  /** True while a save is in flight — disables the row + modal actions. */
  saving: boolean;
  /** Plan excludes Call Transfer — nothing here may be written. */
  locked: boolean;
  /** Plan's department allowance; Infinity while it's still being resolved. */
  maxDepartments: number;
  onAdd: (row: {
    name: string;
    number: string;
    description: string;
    ringTimeoutSec: number;
    fallbackMessage: string;
  }) => Promise<boolean>;
  onUpdate: (uid: string, patch: Partial<DraftDept>) => Promise<boolean>;
  onRemove: (uid: string) => Promise<boolean>;
}

/** Departments editor. Add/edit go through a modal; every change saves immediately, no separate Save button. */
function DepartmentsSection({
  draft,
  saving,
  locked,
  maxDepartments,
  onAdd,
  onUpdate,
  onRemove,
}: DepartmentsSectionProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [editingUid, setEditingUid] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [number, setNumber] = useState("");
  const [description, setDescription] = useState("");
  const [ring, setRing] = useState(DEFAULT_RING_SEC);
  const [fallback, setFallback] = useState(DEFAULT_FALLBACK_MESSAGE);
  // Field-level errors, shown under the inputs after a failed submit attempt.
  const [errors, setErrors] = useState<{ name?: string; number?: string }>({});
  // Delete goes straight to the server, so gate it behind a confirm dialog.
  const [confirmDept, setConfirmDept] = useState<DraftDept | null>(null);
  const [removing, setRemoving] = useState(false);

  const handleRemove = async () => {
    if (!confirmDept) return;
    setRemoving(true);
    const ok = await onRemove(confirmDept.uid);
    setRemoving(false);
    if (ok) setConfirmDept(null);
  };

  const openAdd = () => {
    setEditingUid(null);
    setName("");
    setNumber("");
    setDescription("");
    setRing(DEFAULT_RING_SEC);
    // Prefill the default line; as a greyed placeholder it read as "nothing will be said".
    setFallback(DEFAULT_FALLBACK_MESSAGE);
    setErrors({});
    setModalOpen(true);
  };

  const openEdit = (d: DraftDept) => {
    setEditingUid(d.uid);
    setName(d.name);
    setNumber(d.number);
    setDescription(d.description);
    setRing(d.ringTimeoutSec);
    setFallback(d.fallbackMessage);
    setErrors({});
    setModalOpen(true);
  };

  const handleSubmit = async () => {
    const trimmedName = name.trim();
    const trimmedNumber = number.trim();
    const nextErrors: { name?: string; number?: string } = {};
    if (!trimmedName) nextErrors.name = "Department name is required.";
    if (!trimmedNumber) nextErrors.number = "Phone number is required.";
    else if (phoneError(trimmedNumber)) nextErrors.number = phoneError(trimmedNumber) as string;
    setErrors(nextErrors);
    if (nextErrors.name || nextErrors.number) return;
    // Persist immediately; only close the modal once the save succeeds.
    const ok = editingUid
      ? await onUpdate(editingUid, {
          name: trimmedName,
          number: number.trim(),
          description: description.trim(),
          ringTimeoutSec: ring,
          fallbackMessage: fallback,
        })
      : await onAdd({
          name: trimmedName,
          number: number.trim(),
          description: description.trim(),
          ringTimeoutSec: ring,
          fallbackMessage: fallback,
        });
    if (ok) setModalOpen(false);
  };

  return (
    <div className="space-y-3 rounded-lg border border-border bg-background/50 p-3">
      <div className="flex items-center gap-2">
        <Building2 className="size-4 text-primary" />
        <p className="text-sm font-medium">Departments</p>
        {draft.length > 0 && (
          <Badge variant="neutral" className="ml-auto">
            {draft.length}
          </Badge>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Add a line per department. The AI asks the caller which one they need, then transfers to
        that department's number.
      </p>

      {/* Over the allowance (legacy config or a lowered plan): the assistant only uses the first N, so say so or the extras look live. */}
      {!locked && Number.isFinite(maxDepartments) && draft.length > maxDepartments && (
        <div className="rounded-md border border-warning/40 bg-warning-tint px-3 py-2">
          <p className="text-xs text-warning">
            You have {draft.length} departments but your plan includes {maxDepartments}. The AI only
            transfers to the first {maxDepartments} — remove{" "}
            {draft.length - maxDepartments} or upgrade your plan.
          </p>
        </div>
      )}

      {draft.map((d) => (
        <div
          key={d.uid}
          className="flex items-center gap-3 rounded-md border border-border px-3 py-2"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{d.name || "Unnamed"}</p>
            {d.number && (
              <p className="truncate text-xs text-muted-foreground">{d.number}</p>
            )}
            {d.description && (
              <p className="truncate text-xs text-muted-foreground italic">{d.description}</p>
            )}
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Timer className="size-3" />
              {d.ringTimeoutSec}s wait
            </p>
          </div>
          <Switch
            checked={d.enabled}
            onCheckedChange={(v) => onUpdate(d.uid, { enabled: v })}
            disabled={saving}
            aria-label="Enable department"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => openEdit(d)}
            disabled={saving}
            aria-label="Edit department"
          >
            <Pencil className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setConfirmDept(d)}
            disabled={saving}
            aria-label="Remove department"
          >
            <Trash2 className="size-4 text-danger" />
          </Button>
        </div>
      ))}

      <Button
        type="button"
        variant="secondary"
        className="w-full"
        onClick={openAdd}
        disabled={saving || locked || draft.length >= maxDepartments}
      >
        <Plus className="size-4" />
        Add Department
      </Button>
      {!locked && Number.isFinite(maxDepartments) && draft.length >= maxDepartments && (
        <p className="text-center text-xs text-muted-foreground">
          Your plan includes {maxDepartments} department{maxDepartments === 1 ? "" : "s"}. Upgrade to
          add more.
        </p>
      )}

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingUid ? "Edit Department" : "Add Department"}
            </DialogTitle>
            <DialogDescription>
              {editingUid
                ? "Update the department details below."
                : "Enter the details for the new department."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="dept-name">
                Department name <span className="text-danger">*</span>
              </Label>
              <input
                id="dept-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (errors.name) setErrors((prev) => ({ ...prev, name: undefined }));
                }}
                placeholder="e.g. Sales"
                maxLength={60}
                aria-invalid={Boolean(errors.name)}
                className={cn(
                  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:focus-ring",
                  errors.name && "border-danger",
                )}
              />
              {errors.name && <p className="text-xs text-danger">{errors.name}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dept-number">
                Phone number <span className="text-danger">*</span>
              </Label>
              <PhoneInput
                id="dept-number"
                value={number}
                onChange={(v) => {
                  setNumber(v);
                  if (errors.number) setErrors((prev) => ({ ...prev, number: undefined }));
                }}
                placeholder="Number for this department"
                aria-invalid={Boolean(errors.number)}
              />
              {errors.number && <p className="text-xs text-danger">{errors.number}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dept-desc">Description (optional)</Label>
              <input
                id="dept-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="When to route here, e.g. billing, refunds"
                maxLength={200}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:focus-ring"
              />
            </div>

            {/* Per-department waiting time */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-1.5">
                  <Timer className="size-4 text-muted-foreground" />
                  Waiting time
                </Label>
                <span className="text-sm font-medium tabular-nums">{ring}s</span>
              </div>
              <Slider
                min={10}
                max={120}
                step={5}
                value={[ring]}
                onValueChange={([v]) => setRing(v)}
              />
              <p className="text-xs text-muted-foreground">
                How long this department's number rings before the AI gives up and reads its end
                message.
              </p>
            </div>

            {/* Per-department end message */}
            <div className="space-y-1.5">
              <Label htmlFor="dept-end-msg">End message</Label>
              <textarea
                id="dept-end-msg"
                rows={3}
                maxLength={600}
                value={fallback}
                onChange={(e) => setFallback(e.target.value)}
                placeholder={DEFAULT_FALLBACK_MESSAGE}
                className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm focus:focus-ring"
              />
              <p className="text-xs text-muted-foreground">
                Spoken by the AI when this department's transfer can't connect, before ending the
                call.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setModalOpen(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="button" onClick={handleSubmit} disabled={saving}>
              {saving ? "Saving…" : editingUid ? "Update" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Removal is immediate and server-persisted, so confirm before deleting. */}
      <Dialog open={!!confirmDept} onOpenChange={(o) => !o && !removing && setConfirmDept(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove department?</DialogTitle>
            <DialogDescription>
              Callers will no longer be transferred to{" "}
              <span className="font-medium text-foreground">
                {confirmDept?.name || "this department"}
              </span>
              {confirmDept?.number ? ` (${confirmDept.number})` : ""}. This takes effect
              immediately.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmDept(null)}
              disabled={removing}
            >
              Cancel
            </Button>
            <Button type="button" variant="danger" onClick={handleRemove} disabled={removing}>
              {removing && <Loader2 className="size-4 animate-spin" />}
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
