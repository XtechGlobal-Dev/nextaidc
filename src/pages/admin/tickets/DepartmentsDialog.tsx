import { useEffect, useState } from "react";
import {
  AlignLeft,
  Building2,
  ChevronLeft,
  Eye,
  EyeOff,
  FileCheck,
  FileText,
  Loader2,
  Pencil,
  Plus,
  Search,
  Settings,
  Trash2,
  TrendingUp,
  UserRound,
  Users,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDeleteDialog } from "@/components/ui/ConfirmDeleteDialog";
import { api, ApiError, type StaffMember } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { AdminTicketDepartment, TicketLaneInfo } from "@/types/ticket";

// Support queues. Every member (via role or directly) sees every conversation, so a queue with requests can be disabled but not deleted.
// Which queues exist is the platform's call — brand admins get a narrower mode: staffing only, definition read-only.

interface DraftState {
  id: string | null;
  name: string;
  description: string;
  requesterVisible: boolean;
  enabled: boolean;
  order: number;
  /** Staff granted this queue personally — ids, so ticking is cheap. */
  staffIds: string[];
}

const EMPTY_DRAFT: DraftState = {
  id: null,
  name: "",
  description: "",
  requesterVisible: true,
  enabled: true,
  order: 0,
  staffIds: [],
};

// Glyph + tint guessed from the name; unmatched names cycle by position so two unknowns never look identical.
const TILE_TONES: { icon: LucideIcon; tile: string }[] = [
  { icon: Users, tile: "bg-primary-tint text-primary" },
  { icon: FileCheck, tile: "bg-success-tint text-success" },
  { icon: Settings, tile: "bg-violet-500/12 text-violet-600 dark:text-violet-400" },
  { icon: TrendingUp, tile: "bg-warning-tint text-warning" },
];

const TILE_BY_KEYWORD: [RegExp, (typeof TILE_TONES)[number]][] = [
  [/general|other|misc|account/i, TILE_TONES[0]],
  [/bill|invoice|payment|refund|finance|wallet|payout/i, TILE_TONES[1]],
  [/tech|support|integration|engineer|it\b|bug|domain/i, TILE_TONES[2]],
  [/sales|upgrade|plan|pricing|commercial/i, TILE_TONES[3]],
];

function tileFor(name: string, index: number) {
  const hit = TILE_BY_KEYWORD.find(([re]) => re.test(name));
  return hit ? hit[1] : TILE_TONES[index % TILE_TONES.length];
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function DepartmentsDialog({
  open,
  onOpenChange,
  lane,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lane: TicketLaneInfo;
  onChanged: () => void;
}) {
  const [departments, setDepartments] = useState<AdminTicketDepartment[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [saving, setSaving] = useState(false);
  const [toDelete, setToDelete] = useState<AdminTicketDepartment | null>(null);
  /** The "add team member" picker inside the form, and what's typed in it. */
  const [adding, setAdding] = useState(false);
  const [memberQuery, setMemberQuery] = useState("");

  // The `brand` lane is answered by the super admin alone, so the membership block is left out there.
  const hasTeam = lane.lane === "support";
  // Support lane caller is a brand admin: queues are the platform's to define, this dialog only staffs them (see handlerLane).
  const managed = lane.lane === "support";

  // A fresh draft starts with the picker closed and the search empty.
  const draftKey = draft ? (draft.id ?? "new") : null;
  useEffect(() => {
    setAdding(false);
    setMemberQuery("");
  }, [draftKey]);

  async function load() {
    setLoading(true);
    try {
      // The staff list only ever populates the member picker, so a failure there
      // must not take the departments down with it.
      const [depts, people] = await Promise.all([
        api.admin.tickets.departments.list(),
        hasTeam ? api.admin.staff.list().catch(() => [] as StaffMember[]) : Promise.resolve([]),
      ]);
      setDepartments(depts);
      setStaff(people);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't load departments");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) void load();
    else setDraft(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Staff who reach this queue via their role. Locked chips — revoking here would silently edit the role for everyone on it.
  function roleGrantedMembers(departmentId: string | null): StaffMember[] {
    if (!departmentId) return [];
    return staff.filter((u) => u.roleDepartments.some((d) => d.id === departmentId));
  }

  async function save() {
    if (!draft) return;
    if (!managed && draft.name.trim().length < 2) {
      toast.error("Give the department a name");
      return;
    }
    setSaving(true);
    try {
      if (managed) {
        // Membership is all a brand admin may change — sending anything else
        // would be refused, not ignored.
        await api.admin.tickets.departments.update(draft.id!, { staffIds: draft.staffIds });
        toast.success("Team updated");
      } else {
        const payload = {
          name: draft.name.trim(),
          description: draft.description.trim(),
          requesterVisible: draft.requesterVisible,
          enabled: draft.enabled,
          order: draft.order,
          ...(hasTeam ? { staffIds: draft.staffIds } : {}),
        };
        if (draft.id) await api.admin.tickets.departments.update(draft.id, payload);
        else await api.admin.tickets.departments.create(payload);
        toast.success(draft.id ? "Department updated" : "Department created");
      }
      setDraft(null);
      await load();
      onChanged();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't save the department");
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(dept: AdminTicketDepartment) {
    try {
      await api.admin.tickets.departments.update(dept.id, { enabled: !dept.enabled });
      await load();
      onChanged();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't update the department");
    }
  }

  async function confirmDelete() {
    if (!toDelete) return;
    await api.admin.tickets.departments.remove(toDelete.id);
    toast.success(`"${toDelete.name}" deleted`);
    setToDelete(null);
    await load();
    onChanged();
  }

  function startEdit(d: AdminTicketDepartment) {
    setDraft({
      id: d.id,
      name: d.name,
      description: d.description,
      requesterVisible: d.requesterVisible,
      enabled: d.enabled,
      order: d.order,
      staffIds: d.staff.map((m) => m.id),
    });
  }

  return (
    <>
      {/* One dialog, two faces: list or form swapped in place, no stacked modal. */}
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (o) return;
          // Escape / X from the form goes back to the list, not out of the dialog.
          if (draft) setDraft(null);
          else onOpenChange(false);
        }}
      >
        <DialogContent
          className={cn(
            "flex max-h-[92dvh] flex-col gap-0 p-6 sm:max-h-[90vh]",
            draft ? "sm:max-w-lg" : "sm:max-w-2xl",
          )}
        >
          {draft ? (
            <>
              <DialogHeader className="shrink-0">
                <div className="flex items-start gap-3">
                  <button
                    type="button"
                    onClick={() => setDraft(null)}
                    className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    aria-label="Back to departments"
                  >
                    <ChevronLeft className="size-4" />
                  </button>
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary-tint text-primary">
                    <Building2 className="size-5" strokeWidth={1.75} />
                  </div>
                  <div className="min-w-0 pt-1">
                    <DialogTitle className="text-xl font-semibold tracking-tight">
                      {managed
                        ? `Team for ${draft.name}`
                        : draft.id
                          ? "Edit department"
                          : "New department"}
                    </DialogTitle>
                    <DialogDescription className="mt-1 text-sm">
                      {managed
                        ? "Who works this queue. The department itself is set up by the platform — ask them to rename or retire it."
                        : draft.id
                          ? "Rename it, change who's on the team, or hide it from requesters."
                          : "A queue requesters can pick, and who gets to work it."}
                    </DialogDescription>
                  </div>
                </div>
              </DialogHeader>

              <div className="mt-6 min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
                {managed && (
                  <div className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm">
                    <p className="font-semibold">{draft.name}</p>
                    {draft.description && (
                      <p className="mt-0.5 text-muted-foreground">{draft.description}</p>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">
                      {draft.requesterVisible ? "Offered to customers" : "Internal only"}
                      {!draft.enabled && " · Off"}
                    </p>
                  </div>
                )}
                <div className={cn("grid gap-4 sm:grid-cols-[1fr_9rem]", managed && "hidden")}>
                  <div className="space-y-2">
                    <Label htmlFor="dept-name" className="text-sm font-medium">
                      Name <span className="text-danger">*</span>
                    </Label>
                    <div className="relative">
                      <span className="pointer-events-none absolute left-2.5 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-lg bg-primary-tint text-primary">
                        <FileText className="size-4" />
                      </span>
                      <Input
                        id="dept-name"
                        value={draft.name}
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                        placeholder="e.g. Billing"
                        maxLength={60}
                        className="h-12 pl-[3.25rem]"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="dept-order" className="text-sm font-medium">
                      Order <span className="text-danger">*</span>
                    </Label>
                    <div className="relative">
                      <span className="pointer-events-none absolute left-2.5 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                        <AlignLeft className="size-4" />
                      </span>
                      <Input
                        id="dept-order"
                        type="number"
                        min={0}
                        max={999}
                        value={draft.order}
                        onChange={(e) =>
                          setDraft({ ...draft, order: Number(e.target.value) || 0 })
                        }
                        className="h-12 pl-[3.25rem]"
                      />
                    </div>
                  </div>
                </div>

                <div className={cn("space-y-2", managed && "hidden")}>
                  <Label htmlFor="dept-desc" className="text-sm font-medium">
                    Description
                  </Label>
                  <Input
                    id="dept-desc"
                    value={draft.description}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                    placeholder="Shown under the name in the requester's picker"
                    maxLength={200}
                    className="h-12"
                  />
                </div>

                <label
                  className={cn(
                    "flex cursor-pointer items-center gap-3.5 rounded-xl border border-success/25 bg-success-tint/40 px-4 py-3.5 text-sm transition-colors hover:bg-success-tint/60",
                    managed && "hidden",
                  )}
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-success-tint text-success">
                    <UserRound className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">Offer to requesters</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      Off = the team can file into it, but nobody can pick it.
                    </span>
                  </span>
                  <Switch
                    checked={draft.requesterVisible}
                    onCheckedChange={(v) => setDraft({ ...draft, requesterVisible: v })}
                  />
                </label>

                {/* Team members see every conversation in the queue, assigned or not. Only current members listed; the picker searches the rest. */}
                {hasTeam &&
                  (() => {
                    const granted = roleGrantedMembers(draft.id);
                    const members = [
                      ...granted.map((m) => ({ user: m, fromRole: true })),
                      ...staff
                        .filter(
                          (u) =>
                            draft.staffIds.includes(u.id) && !granted.some((m) => m.id === u.id),
                        )
                        .map((u) => ({ user: u, fromRole: false })),
                    ];
                    const onTeam = new Set(members.map((m) => m.user.id));
                    const q = memberQuery.trim().toLowerCase();
                    const candidates = staff.filter(
                      (u) =>
                        !onTeam.has(u.id) &&
                        (!q ||
                          (u.fullName ?? "").toLowerCase().includes(q) ||
                          u.email.toLowerCase().includes(q)),
                    );
                    const display = (u: StaffMember) => u.fullName || u.email;
                    const initial = (u: StaffMember) =>
                      display(u).trim().charAt(0).toUpperCase();
                    const addMember = (id: string) => {
                      setDraft((prev) =>
                        prev && !prev.staffIds.includes(id)
                          ? { ...prev, staffIds: [...prev.staffIds, id] }
                          : prev,
                      );
                      setMemberQuery("");
                    };
                    const removeMember = (id: string) =>
                      setDraft((prev) =>
                        prev
                          ? { ...prev, staffIds: prev.staffIds.filter((sid) => sid !== id) }
                          : prev,
                      );

                    return (
                      <div className="space-y-2.5">
                        <div>
                          <p className="flex items-center gap-2 text-sm font-semibold">
                            <Users className="size-4 text-primary" /> Team members
                            {members.length > 0 && (
                              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
                                {members.length}
                              </span>
                            )}
                          </p>
                          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                            Everyone here sees every conversation in this department, assigned or
                            not. Admins always do.
                          </p>
                        </div>

                        {members.length > 0 && (
                          <div className="max-h-52 space-y-2 overflow-y-auto pr-0.5">
                            {members.map(({ user: u, fromRole }) => (
                              <div
                                key={u.id}
                                title={
                                  fromRole
                                    ? `Granted by the ${u.roleName} role — edit the role to change it`
                                    : undefined
                                }
                                className="flex items-center gap-3.5 rounded-xl border border-border px-3.5 py-2.5"
                              >
                                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary-tint text-sm font-semibold text-primary">
                                  {initial(u)}
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-sm font-medium">
                                    {display(u)}
                                  </span>
                                  <span className="block truncate text-xs text-muted-foreground">
                                    {u.email}
                                  </span>
                                </span>
                                {fromRole ? (
                                  <Badge variant="outline" className="shrink-0 text-[11px]">
                                    {u.roleName} role
                                  </Badge>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => removeMember(u.id)}
                                    className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-danger-tint hover:text-danger"
                                    aria-label={`Remove ${display(u)}`}
                                  >
                                    <X className="size-4" />
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        )}

                        {staff.length === 0 ? (
                          <p className="rounded-xl border border-dashed border-border px-4 py-3 text-xs text-muted-foreground">
                            No staff accounts yet. Create one from Staff, then come back to add
                            them to this queue.
                          </p>
                        ) : adding ? (
                          <div className="overflow-hidden rounded-xl border border-primary/40 bg-background">
                            <div className="flex items-center gap-2 border-b border-border px-3">
                              <Search className="size-4 shrink-0 text-muted-foreground" />
                              <input
                                autoFocus
                                value={memberQuery}
                                onChange={(e) => setMemberQuery(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Escape") {
                                    e.preventDefault();
                                    setAdding(false);
                                  } else if (e.key === "Enter" && candidates[0]) {
                                    e.preventDefault();
                                    addMember(candidates[0].id);
                                  }
                                }}
                                placeholder="Search staff by name or email"
                                className="h-11 w-full border-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                              />
                              <button
                                type="button"
                                onClick={() => setAdding(false)}
                                className="rounded-md p-1 text-muted-foreground hover:bg-muted"
                                aria-label="Close picker"
                              >
                                <X className="size-4" />
                              </button>
                            </div>
                            <div className="max-h-48 overflow-y-auto p-1.5">
                              {candidates.length === 0 ? (
                                <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                                  {q ? "No staff match that." : "Everyone is already on this team."}
                                </p>
                              ) : (
                                candidates.map((u) => (
                                  <button
                                    key={u.id}
                                    type="button"
                                    onClick={() => addMember(u.id)}
                                    className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-primary-tint-soft"
                                  >
                                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-foreground">
                                      {initial(u)}
                                    </span>
                                    <span className="min-w-0 flex-1">
                                      <span className="block truncate text-sm font-medium">
                                        {display(u)}
                                      </span>
                                      <span className="block truncate text-xs text-muted-foreground">
                                        {u.email}
                                        {u.roleName ? ` · ${u.roleName}` : ""}
                                      </span>
                                    </span>
                                    <Plus className="size-4 shrink-0 text-primary" />
                                  </button>
                                ))
                              )}
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setAdding(true)}
                            className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary/40 bg-primary-tint-soft px-4 py-3 text-sm font-semibold text-primary transition-colors hover:bg-primary-tint"
                          >
                            <Plus className="size-4" /> Add team member
                          </button>
                        )}
                      </div>
                    );
                  })()}
              </div>

              <DialogFooter className="mt-5 shrink-0 border-t border-border pt-5">
                <Button variant="outline" size="lg" onClick={() => setDraft(null)} disabled={saving}>
                  Cancel
                </Button>
                <Button size="lg" onClick={() => void save()} disabled={saving}>
                  {saving && <Loader2 className="size-4 animate-spin" />}
                  {managed ? "Save team" : draft.id ? "Save changes" : "Create department"}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader className="shrink-0">
                <div className="flex items-center gap-3">
                  <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary-tint text-primary">
                    <Building2 className="size-5" strokeWidth={1.75} />
                  </div>
                  <DialogTitle className="text-xl font-semibold tracking-tight">
                    {lane.lane === "brand" ? "Platform departments" : "Support departments"}
                  </DialogTitle>
                </div>
                <DialogDescription className="mt-2 text-sm leading-relaxed">
                  {lane.lane === "brand"
                    ? "Brand admins choose one of these when they raise a request with you. They are the platform's own queues — no tenant can see or edit them."
                    : "Your customers choose one of these when they raise a request. The platform sets your departments up — ask them to add, rename or retire one. You decide who works each: grant a whole team at once from the role, or one person at a time from here."}
                </DialogDescription>
              </DialogHeader>

              <div className="mt-4 min-h-0 flex-1 space-y-2.5 overflow-y-auto pr-1">
                {loading ? (
                  <>
                    <Skeleton className="h-24 rounded-xl" />
                    <Skeleton className="h-24 rounded-xl" />
                  </>
                ) : departments.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                    {managed
                      ? "No departments yet — the platform will set yours up. Ask them to add one so requests can be routed."
                      : 'No departments yet. Add one — say "Billing" or "Technical" — so requests can be routed.'}
                  </p>
                ) : (
                  departments.map((d, i) => {
                    const tile = tileFor(d.name, i);
                    return (
                      <div
                        key={d.id}
                        className={cn(
                          "flex items-start gap-3 rounded-xl border border-border bg-card p-3.5 transition-opacity",
                          !d.enabled && "opacity-60",
                        )}
                      >
                        <div
                          className={cn(
                            "flex size-14 shrink-0 items-center justify-center rounded-xl",
                            tile.tile,
                          )}
                        >
                          <tile.icon className="size-6" strokeWidth={1.75} />
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-base font-semibold leading-tight">{d.name}</p>
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
                            {hasTeam && (
                              <>
                                <span className="mx-1.5">•</span>
                                {plural(d.roleCount, "role")}
                                <span className="mx-1.5">•</span>
                                {plural(d.staffCount, "member")}
                              </>
                            )}
                          </p>
                          {d.staff.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {d.staff.map((m) => (
                                <Badge
                                  key={m.id}
                                  variant="outline"
                                  className="gap-1 text-[11px] font-normal"
                                >
                                  <Users className="size-3" /> {m.name}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>

                        <div className="flex shrink-0 items-center gap-2 pt-0.5">
                          {!managed && (
                            <Switch
                              checked={d.enabled}
                              onCheckedChange={() => void toggleEnabled(d)}
                              aria-label={`${d.enabled ? "Disable" : "Enable"} ${d.name}`}
                              className="mr-1"
                            />
                          )}
                          <button
                            type="button"
                            onClick={() => startEdit(d)}
                            className={cn(
                              "flex h-9 items-center justify-center gap-1.5 rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                              managed ? "px-3 text-xs font-medium" : "size-9",
                            )}
                            aria-label={managed ? `Team for ${d.name}` : `Edit ${d.name}`}
                          >
                            {managed ? (
                              <>
                                <Users className="size-3.5" /> Team
                              </>
                            ) : (
                              <Pencil className="size-3.5" />
                            )}
                          </button>
                          {!managed && (
                            <button
                              type="button"
                              onClick={() => setToDelete(d)}
                              className="flex size-9 items-center justify-center rounded-lg border border-border text-danger transition-colors hover:border-danger/40 hover:bg-danger-tint"
                              aria-label={`Delete ${d.name}`}
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Outside the scroll area so it stays reachable however long the list gets. */}
              {!managed && (
                <button
                  type="button"
                  onClick={() => setDraft({ ...EMPTY_DRAFT })}
                  className="mt-3 flex w-full shrink-0 items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary/40 bg-primary-tint-soft px-4 py-3 text-sm font-semibold text-primary transition-colors hover:bg-primary-tint"
                >
                  <Plus className="size-4" /> Add department
                </button>
              )}
            </>
          )}
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
            ? "This department still has requests — the delete will be rejected. Move them first, or turn the department off instead."
            : "Every role and staff member granted this department will lose it."
        }
      />
    </>
  );
}
