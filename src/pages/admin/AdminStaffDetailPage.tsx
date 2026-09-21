import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Building2,
  ChevronDown,
  Loader2,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDeleteDialog } from "@/components/ui/ConfirmDeleteDialog";
import { PageHeaderSkeleton, CardSkeleton } from "@/components/ui/skeleton";
import {
  api,
  ApiError,
  type StaffMember,
  type StaffRole,
  type SectionDef,
} from "@/lib/api";
import { passwordError } from "@/pages/auth/authSchemas";
import { cn, formatDate } from "@/lib/utils";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type FormErrors = {
  fullName?: string;
  email?: string;
  password?: string;
  role?: string;
};

/** Distinct section labels a role's permission keys touch. */
function roleSectionLabels(permissions: string[], sections: SectionDef[]): string[] {
  return sections.filter((s) => permissions.some((p) => p.startsWith(`${s.key}.`))).map((s) => s.label);
}

export default function AdminStaffDetailPage() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();

  const [staff, setStaff] = useState<StaffMember | null>(null);
  const [roles, setRoles] = useState<StaffRole[]>([]);
  const [sections, setSections] = useState<SectionDef[]>([]);
  const [loading, setLoading] = useState(true);

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [roleId, setRoleId] = useState<string | null>(null);

  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [toDelete, setToDelete] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      try {
        const [rolesList, config, existing] = await Promise.all([
          api.admin.roles.list(),
          api.admin.staff.permissions(),
          id ? api.admin.staff.get(id) : null,
        ]);
        if (!active) return;
        setRoles(rolesList);
        setSections(config.sections);
        if (existing) {
          setStaff(existing);
          setFullName(existing.fullName);
          setEmail(existing.email);
          setRoleId(existing.roleId);
        }
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : "Failed to load");
        if (active && id) navigate("/dashboard/admin/staff");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // An existing member with permissions but no role = legacy custom grant.
  const isCustom = !!staff && !staff.roleId && staff.permissions.length > 0;

  function clearError(key: keyof FormErrors) {
    setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
  }

  function validate(): FormErrors {
    const next: FormErrors = {};
    if (fullName.trim().length < 2) next.fullName = "Enter the staff member's full name";
    if (isNew) {
      if (!email.trim()) next.email = "Email is required";
      else if (!EMAIL_RE.test(email.trim())) next.email = "Enter a valid email address";
      const pwErr = passwordError(password);
      if (pwErr) next.password = pwErr;
    }
    if (!roleId) next.role = "Pick a role for this staff member";
    return next;
  }

  async function handleSave() {
    const found = validate();
    if (Object.keys(found).length > 0) {
      setErrors(found);
      if (found.role && !found.fullName && !found.email && !found.password) {
        toast.error(found.role);
      }
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      if (isNew) {
        await api.admin.staff.create({
          email: email.trim(),
          fullName: fullName.trim(),
          password,
          roleId: roleId!,
        });
        toast.success("Staff member created");
      } else {
        const updated = await api.admin.staff.update(id!, {
          fullName: fullName.trim(),
          roleId,
        });
        setStaff(updated);
        toast.success("Staff member updated");
      }
      navigate("/dashboard/admin/staff");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!id) return;
    await api.admin.staff.remove(id);
    toast.success(`${staff?.fullName ?? "Staff member"} removed`);
    navigate("/dashboard/admin/staff");
  }

  const selectedRole = useMemo(() => roles.find((r) => r.id === roleId) ?? null, [roles, roleId]);

  // Queues are read-only here on purpose: they come from the role (edit there) or from
  // Departments → Team members. An editable list would offer to revoke grants this form can't.
  const roleDepartmentIds = useMemo(
    () => new Set((selectedRole?.departments ?? []).map((d) => d.id)),
    [selectedRole],
  );
  const visibleDepartments = useMemo(() => {
    const fromRole = (selectedRole?.departments ?? []).map((d) => ({ ...d, fromRole: true }));
    const direct = (staff?.departments ?? [])
      .filter((d) => !roleDepartmentIds.has(d.id))
      .map((d) => ({ ...d, fromRole: false }));
    return [...fromRole, ...direct];
  }, [selectedRole, staff, roleDepartmentIds]);

  /** Does the chosen role let them open the support inbox at all? */
  const hasTicketAccess = useMemo(
    () => (selectedRole?.permissions ?? []).some((p) => p.startsWith("tickets.") || p.startsWith("brand_tickets.")),
    [selectedRole],
  );

  if (loading) {
    return (
      <div>
        <PageHeaderSkeleton />
        <CardSkeleton className="mt-6 h-96" />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => navigate("/dashboard/admin/staff")}
              aria-label="Back to staff"
            >
              <ArrowLeft className="size-5" />
            </Button>
            {isNew ? "New Staff Member" : staff?.fullName ?? "Staff"}
          </span>
        }
        subtitle={
          isNew
            ? "Create a staff login and assign a role."
            : `Staff member since ${formatDate(staff?.createdAt ?? "")}`
        }
        actions={
          !isNew ? (
            <Badge variant="primary" className="text-sm">
              Staff
            </Badge>
          ) : undefined
        }
      />

      <Card className="mt-6 max-w-xl p-6">
        <div className="grid grid-cols-1 gap-5">
          {!isNew && (
            <div className="flex items-center gap-4 pb-2">
              <span className="flex size-14 shrink-0 items-center justify-center rounded-full bg-primary-tint text-lg font-semibold text-primary">
                {fullName
                  .trim()
                  .split(/\s+/)
                  .slice(0, 2)
                  .map((w) => w[0]?.toUpperCase() ?? "")
                  .join("") || "?"}
              </span>
              <div>
                <p className="text-lg font-semibold">{staff?.fullName}</p>
                <p className="text-sm text-muted-foreground">{staff?.email}</p>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="st-name">Full Name <span className="text-danger">*</span></Label>
            <Input
              id="st-name"
              value={fullName}
              autoComplete="name"
              onChange={(e) => {
                setFullName(e.target.value);
                clearError("fullName");
              }}
              placeholder="e.g. John Smith"
              aria-invalid={!!errors.fullName}
              className={errors.fullName ? "border-danger" : undefined}
            />
            {errors.fullName && <p className="text-xs text-danger">{errors.fullName}</p>}
          </div>

          {isNew ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="st-email">Email <span className="text-danger">*</span></Label>
                <Input
                  id="st-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    clearError("email");
                  }}
                  placeholder="staff@company.com"
                  aria-invalid={!!errors.email}
                  className={errors.email ? "border-danger" : undefined}
                />
                {errors.email && <p className="text-xs text-danger">{errors.email}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="st-pass">Temporary Password <span className="text-danger">*</span></Label>
                <PasswordInput
                  id="st-pass"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    clearError("password");
                  }}
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
          ) : (
            <div className="space-y-2">
              <Label>Email</Label>
              <Input value={email} disabled className="bg-muted" />
              <p className="text-xs text-muted-foreground">
                Email cannot be changed after creation.
              </p>
            </div>
          )}

          {/* ───────── Role selector ───────── */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="st-role">Role <span className="text-danger">*</span></Label>
              <Link
                to="/dashboard/admin/roles/new"
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                <Plus className="size-3.5" /> New role
              </Link>
            </div>

            {roles.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-8 text-center">
                <ShieldCheck className="size-6 text-muted-foreground" />
                <p className="text-sm font-medium">No roles created yet</p>
                <p className="max-w-xs text-xs text-muted-foreground">
                  Create a role first — it defines which sections and columns this staff member can access.
                </p>
                <Button className="mt-1" size="sm" asChild>
                  <Link to="/dashboard/admin/roles/new">
                    <Plus className="size-4" /> Create your first role
                  </Link>
                </Button>
              </div>
            ) : (
              <RoleSelect
                id="st-role"
                roles={roles}
                sections={sections}
                value={roleId}
                invalid={!!errors.role}
                onChange={(rid) => {
                  setRoleId(rid);
                  clearError("role");
                }}
              />
            )}

            {isCustom && (
              <p className="rounded-lg border border-warning/30 bg-warning-tint px-3 py-2 text-xs text-warning">
                This member currently has <span className="font-semibold">custom permissions</span> (no
                role). Picking a role will replace them.
              </p>
            )}
            {errors.role && <p className="text-xs text-danger">{errors.role}</p>}
            {selectedRole && (
              <p className="text-xs text-muted-foreground">
                Assigning <span className="font-medium text-foreground">{selectedRole.name}</span> — inherits{" "}
                {roleSectionLabels(selectedRole.permissions, sections).length} section
                {roleSectionLabels(selectedRole.permissions, sections).length === 1 ? "" : "s"}.
              </p>
            )}
          </div>
        </div>

        {/* Support queues — a read-out of the role picked above, plus any queue
            granted to this person directly. */}
        <div className="mt-6 space-y-2 border-t border-border pt-6">
          <Label className="flex items-center gap-2">
            <Building2 className="size-4 text-primary" /> Support departments
          </Label>
          <p className="text-xs text-muted-foreground">
            {selectedRole ? (
              <>
                Queues that come with the{" "}
                <span className="font-medium text-foreground">{selectedRole.name}</span> role.
                Everyone in a department sees every conversation in it, assigned or not.
              </>
            ) : (
              "Pick a role above to see which support queues it works."
            )}
          </p>

          {visibleDepartments.length > 0 ? (
            <div className="mt-1 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {visibleDepartments.map((d) => (
                <div
                  key={d.id}
                  className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/40 p-3"
                >
                  <Building2 className="mt-0.5 size-4 shrink-0 text-primary" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{d.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {d.fromRole
                        ? `From the ${selectedRole?.name} role`
                        : "Granted to this person directly"}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          ) : selectedRole ? (
            <p
              className={cn(
                "rounded-lg border px-3 py-2 text-xs",
                hasTicketAccess
                  ? "border-warning/40 bg-warning-tint"
                  : "border-dashed border-border text-muted-foreground",
              )}
            >
              The {selectedRole.name} role doesn't work any support department.
              {hasTicketAccess &&
                " It can open the support inbox, but the inbox will be empty until a department is added to the role."}
            </p>
          ) : null}
        </div>

        <div className="mt-6 flex items-center gap-3 border-t border-border pt-6">
          <Button onClick={handleSave} disabled={saving || (isNew && roles.length === 0)}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            {isNew ? "Create Staff Member" : "Save Changes"}
          </Button>
          {!isNew && (
            <Button
              variant="outline"
              className="text-danger hover:bg-danger-tint hover:text-danger"
              onClick={() => setToDelete(true)}
            >
              <Trash2 className="size-4" />
              Delete
            </Button>
          )}
        </div>
      </Card>

      {/* Delete confirm dialog */}
      <ConfirmDeleteDialog
        open={toDelete}
        onOpenChange={(o) => !o && setToDelete(false)}
        resourceType="staff member"
        resourceName={staff?.fullName ?? ""}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

// Role picker on the shared DropdownMenu so it inherits click-away, keyboard nav and theming.
function RoleSelect({
  id,
  roles,
  sections,
  value,
  onChange,
  invalid,
}: {
  id?: string;
  roles: StaffRole[];
  sections: SectionDef[];
  value: string | null;
  /** Passed the role's id when picked, or null when the selected role is
   *  clicked again (toggled off / unselected). */
  onChange: (roleId: string | null) => void;
  invalid?: boolean;
}) {
  const selected = roles.find((r) => r.id === value) ?? null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          id={id}
          type="button"
          aria-invalid={invalid}
          className={cn(
            "flex w-full items-center justify-between gap-2 rounded-lg border bg-background px-3 py-2.5 text-left text-sm transition-colors",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
            "data-[state=open]:border-primary/60",
            invalid ? "border-danger" : "border-border hover:border-primary/40",
          )}
        >
          {selected ? (
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-medium">{selected.name}</span>
              {selected.description && (
                <span className="truncate text-xs text-muted-foreground">{selected.description}</span>
              )}
            </span>
          ) : (
            <span className="text-muted-foreground">Select a role…</span>
          )}
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-80 w-(--radix-dropdown-menu-trigger-width) overflow-y-auto"
      >
        {roles.map((r) => {
          const active = r.id === value;
          const secLabels = roleSectionLabels(r.permissions, sections);
          return (
            <DropdownMenuItem
              key={r.id}
              // Clicking the selected role again clears the selection.
              onSelect={() => onChange(active ? null : r.id)}
              className={cn("mb-1 items-start gap-3 py-2.5 last:mb-0", active && "bg-primary-tint")}
            >
              <span
                aria-hidden
                className={cn(
                  "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border-2 transition-colors",
                  active ? "border-primary" : "border-muted-foreground/40",
                )}
              >
                {active && <span className="size-2 rounded-full bg-primary" />}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="truncate font-medium text-foreground">{r.name}</span>
                {r.description && (
                  <span className="text-xs text-muted-foreground">{r.description}</span>
                )}
                <span className="flex flex-wrap gap-1">
                  {secLabels.length === 0 ? (
                    <span className="text-xs text-muted-foreground">No permissions</span>
                  ) : secLabels.length === sections.length ? (
                    <Badge variant="premium">All sections</Badge>
                  ) : (
                    <>
                      {secLabels.slice(0, 4).map((label) => (
                        <Badge key={label} variant="neutral">
                          {label}
                        </Badge>
                      ))}
                      {secLabels.length > 4 && (
                        <Badge variant="neutral">+{secLabels.length - 4}</Badge>
                      )}
                    </>
                  )}
                </span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
