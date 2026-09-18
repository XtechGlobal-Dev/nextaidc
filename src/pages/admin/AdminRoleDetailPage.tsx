import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Building2, Loader2, Save, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDeleteDialog } from "@/components/ui/ConfirmDeleteDialog";
import { PageHeaderSkeleton, CardSkeleton } from "@/components/ui/skeleton";
import { PermissionSelector } from "@/components/admin/PermissionSelector";
import {
  api,
  ApiError,
  type SectionDef,
  type CapabilityDef,
  type StaffRole,
} from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { isSuperAdminRole } from "@/lib/roles";
import { useAuthStore } from "@/stores/useAuthStore";
import type { AdminTicketDepartment } from "@/types/ticket";

type FormErrors = { name?: string };

export default function AdminRoleDetailPage() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  // Whose departments these are decides what to say when there are none: the
  // super admin makes the platform's own; a brand admin is given theirs.
  const isSuperAdmin = isSuperAdminRole(useAuthStore((s) => s.user?.role));

  const [role, setRole] = useState<StaffRole | null>(null);
  const [sections, setSections] = useState<SectionDef[]>([]);
  const [capabilities, setCapabilities] = useState<CapabilityDef[]>([]);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedPerms, setSelectedPerms] = useState<Set<string>>(new Set());
  // Queues this role works — the capability says what it may do, these say to which tickets.
  // Capability with no queue = an empty inbox, hence the warning below.
  const [departments, setDepartments] = useState<AdminTicketDepartment[]>([]);
  const [selectedDepartments, setSelectedDepartments] = useState<Set<string>>(new Set());

  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [toDelete, setToDelete] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      try {
        const [config, existing, depts] = await Promise.all([
          api.admin.staff.permissions(),
          id ? api.admin.roles.get(id) : null,
          // A fresh install has no queues yet — that isn't an error, the block
          // below just tells the admin to create one first.
          api.admin.tickets.departments.list().catch(() => [] as AdminTicketDepartment[]),
        ]);
        if (!active) return;
        setSections(config.sections);
        setCapabilities(config.capabilities);
        setDepartments(depts);
        if (existing) {
          setRole(existing);
          setName(existing.name);
          setDescription(existing.description);
          setSelectedPerms(new Set(existing.permissions));
          setSelectedDepartments(new Set(existing.departments.map((d) => d.id)));
        }
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : "Failed to load");
        if (active && id) navigate("/dashboard/admin/roles");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  /** Ticking any ticket capability without a queue is a dead end — warn. Either lane's inbox: a brand's
   *  `tickets.*` or the platform team's `brand_tickets.*` (both read "Support Tickets" in the matrix). */
  const hasTicketAccess = useMemo(
    () => [...selectedPerms].some((p) => p.startsWith("tickets.") || p.startsWith("brand_tickets.")),
    [selectedPerms],
  );

  const activeSections = useMemo(
    () =>
      sections.filter((s) =>
        s.capabilities.some((c) => selectedPerms.has(`${s.key}.${c}`)),
      ),
    [sections, selectedPerms],
  );

  function selectAll() {
    const all = new Set<string>();
    sections.forEach((s) => {
      s.capabilities.forEach((c) => all.add(`${s.key}.${c}`));
      s.fields?.forEach((f) => all.add(`${s.key}.field.${f.key}`));
    });
    setSelectedPerms(all);
  }

  function validate(): FormErrors {
    const next: FormErrors = {};
    if (name.trim().length < 2) next.name = "Enter a role title (at least 2 characters)";
    return next;
  }

  async function handleSave() {
    const found = validate();
    if (Object.keys(found).length > 0) {
      setErrors(found);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const permissions = [...selectedPerms];
      const departmentIds = [...selectedDepartments];
      if (isNew) {
        await api.admin.roles.create({
          name: name.trim(),
          description: description.trim(),
          permissions,
          departmentIds,
        });
        toast.success("Role created");
      } else {
        await api.admin.roles.update(id!, {
          name: name.trim(),
          description: description.trim(),
          permissions,
          departmentIds,
        });
        toast.success("Role updated");
      }
      navigate("/dashboard/admin/roles");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to save role");
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!id) return;
    await api.admin.roles.remove(id);
    toast.success(`Role "${role?.name ?? ""}" deleted`);
    navigate("/dashboard/admin/roles");
  }

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
              onClick={() => navigate("/dashboard/admin/roles")}
              aria-label="Back to roles"
            >
              <ArrowLeft className="size-5" />
            </Button>
            {isNew ? "New Role" : role?.name ?? "Role"}
          </span>
        }
        subtitle={
          isNew
            ? "Define a named role and pick exactly what it can see and do."
            : `Created ${formatDate(role?.createdAt ?? "")}${
                role?.memberCount ? ` · ${role.memberCount} staff assigned` : ""
              }`
        }
        actions={
          !isNew ? (
            <Badge variant="primary" className="gap-1.5 text-sm">
              <ShieldCheck className="size-3.5" /> Role
            </Badge>
          ) : undefined
        }
      />

      <Card className="mt-6 p-6">
        <div className="grid max-w-2xl gap-5">
          <div className="space-y-1.5">
            <Label htmlFor="role-name">
              Role title <span className="text-danger">*</span>
            </Label>
            <Input
              id="role-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setErrors((prev) => (prev.name ? { ...prev, name: undefined } : prev));
              }}
              placeholder="e.g. Support Agent, Finance, Ops"
              aria-invalid={!!errors.name}
              className={errors.name ? "border-danger" : undefined}
            />
            {errors.name && <p className="text-xs text-danger">{errors.name}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="role-desc">Description</Label>
            <Input
              id="role-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this role for? (optional)"
            />
          </div>
        </div>

        {/* Permission selection */}
        <div className="mt-8 border-t border-border pt-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Permissions</h3>
              <p className="text-sm text-muted-foreground">
                Tick what this role can do in each section. Expand a table section to choose which
                columns it can see.
              </p>
            </div>
            <div className="flex shrink-0 gap-2 text-xs">
              <button type="button" onClick={selectAll} className="font-medium text-primary hover:underline">
                Select all
              </button>
              <span className="text-muted-foreground">|</span>
              <button
                type="button"
                onClick={() => setSelectedPerms(new Set())}
                className="font-medium text-primary hover:underline"
              >
                Clear
              </button>
            </div>
          </div>

          <PermissionSelector
            sections={sections}
            capabilities={capabilities}
            value={selectedPerms}
            onChange={setSelectedPerms}
          />

          {activeSections.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1.5">
              <span className="mr-1 self-center text-xs text-muted-foreground">Grants access to:</span>
              {activeSections.length === sections.length ? (
                <Badge variant="premium">All sections</Badge>
              ) : (
                activeSections.map((s) => (
                  <Badge key={s.key} variant="neutral">
                    {s.label}
                  </Badge>
                ))
              )}
            </div>
          )}
        </div>

        {/* Ticket departments — the other half of support access. */}
        <div className="mt-8 border-t border-border pt-6">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <Building2 className="size-4 text-primary" /> Support departments
              </h3>
              <p className="text-sm text-muted-foreground">
                Which support queues this role works. Ticking "Support Tickets" above lets it open
                requests; these decide <em>which</em> ones.
              </p>
            </div>
            {departments.length > 0 && (
              <div className="flex shrink-0 gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => setSelectedDepartments(new Set(departments.map((d) => d.id)))}
                  className="font-medium text-primary hover:underline"
                >
                  Select all
                </button>
                <span className="text-muted-foreground">|</span>
                <button
                  type="button"
                  onClick={() => setSelectedDepartments(new Set())}
                  className="font-medium text-primary hover:underline"
                >
                  Clear
                </button>
              </div>
            )}
          </div>

          {departments.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              {isSuperAdmin
                ? "No platform departments exist yet. Create them from Brand Requests → Departments, then come back to grant them here."
                : "No support departments yet. The platform sets them up for your brand — ask them to add one, then come back to grant it here."}
            </p>
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                {departments.map((d) => (
                  <label
                    key={d.id}
                    className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3 transition-colors hover:bg-muted/40"
                  >
                    <Checkbox
                      checked={selectedDepartments.has(d.id)}
                      onCheckedChange={() =>
                        setSelectedDepartments((prev) => {
                          const next = new Set(prev);
                          if (next.has(d.id)) next.delete(d.id);
                          else next.add(d.id);
                          return next;
                        })
                      }
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{d.name}</span>
                      {d.description && (
                        <span className="block text-xs text-muted-foreground">{d.description}</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>

              {hasTicketAccess && selectedDepartments.size === 0 && (
                <p className="mt-3 rounded-lg border border-warning/40 bg-warning-tint px-3 py-2 text-xs">
                  This role can open the support inbox but isn't assigned a department, so it will
                  see nothing there. Tick at least one.
                </p>
              )}
            </>
          )}
        </div>

        <div className="mt-6 flex items-center gap-3 border-t border-border pt-6">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            {isNew ? "Create Role" : "Save Changes"}
          </Button>
          {!isNew && (
            <Button
              variant="outline"
              className="text-danger hover:bg-danger-tint hover:text-danger"
              onClick={() => setToDelete(true)}
            >
              <Trash2 className="size-4" /> Delete
            </Button>
          )}
        </div>
      </Card>

      {/* Delete confirm */}
      <ConfirmDeleteDialog
        open={toDelete}
        onOpenChange={(o) => !o && setToDelete(false)}
        resourceType="role"
        resourceName={role?.name ?? ""}
        onConfirm={confirmDelete}
        description={
          role?.memberCount
            ? "Staff currently assigned to this role must be reassigned first, or the delete will be rejected."
            : undefined
        }
      />
    </div>
  );
}
