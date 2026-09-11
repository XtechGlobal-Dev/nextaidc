import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Pencil, Plus, ShieldCheck, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDeleteDialog } from "@/components/ui/ConfirmDeleteDialog";
import {
  DataCard,
  DataCardAvatar,
  DataCardHeader,
  DataCardPills,
  DataCardGrid,
  CardField,
} from "@/components/ui/data-card";
import { Pagination } from "@/components/ui/pagination";
import { usePagination } from "@/hooks/usePagination";
import { api, ApiError, type StaffRole, type SectionDef } from "@/lib/api";

/** Stable stand-in for the pre-load `null`, so paging doesn't re-slice each render. */
const EMPTY_ROLES: StaffRole[] = [];

/** Distinct section labels a role's permission keys touch. */
function roleSections(permissions: string[], sections: SectionDef[]): string[] {
  return sections.filter((s) => permissions.some((p) => p.startsWith(`${s.key}.`))).map((s) => s.label);
}

function roleInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function AdminRolesPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<StaffRole[] | null>(null);
  const [sections, setSections] = useState<SectionDef[]>([]);
  const [toDelete, setToDelete] = useState<StaffRole | null>(null);

  const {
    page,
    pageSize,
    pageItems: pageRows,
    total,
    setPage,
    setPageSize,
  } = usePagination(rows ?? EMPTY_ROLES);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [list, config] = await Promise.all([
          api.admin.roles.list(),
          api.admin.staff.permissions(),
        ]);
        if (active) {
          setRows(list);
          setSections(config.sections);
        }
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : "Failed to load roles");
        if (active) setRows([]);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const totalSections = useMemo(() => sections.length, [sections]);

  const renderAccess = (secLabels: string[]) => (
    <div className="flex flex-wrap gap-1">
      {secLabels.length === 0 ? (
        <span className="text-xs text-muted-foreground">No permissions</span>
      ) : secLabels.length === totalSections && totalSections > 0 ? (
        <Badge variant="premium">All sections</Badge>
      ) : (
        <>
          {secLabels.slice(0, 4).map((label) => (
            <Badge key={label} variant="neutral">
              {label}
            </Badge>
          ))}
          {secLabels.length > 4 && <Badge variant="neutral">+{secLabels.length - 4}</Badge>}
        </>
      )}
    </div>
  );

  const renderActions = (r: StaffRole) => (
    <div className="flex items-center justify-end gap-1">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => navigate(`/dashboard/admin/roles/${r.id}`)}
        aria-label={`Edit ${r.name}`}
      >
        <Pencil className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="text-danger hover:bg-danger-tint hover:text-danger"
        onClick={() => setToDelete(r)}
        aria-label={`Delete ${r.name}`}
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  );

  // Throws on failure so ConfirmDeleteDialog surfaces the error and stays open;
  // it owns the loading state and closes on success.
  async function confirmDelete() {
    if (!toDelete) return;
    await api.admin.roles.remove(toDelete.id);
    setRows((prev) => (prev ?? []).filter((r) => r.id !== toDelete.id));
    toast.success(`Role "${toDelete.name}" deleted`);
  }

  return (
    <div>
      <PageHeader
        title="Roles"
        subtitle="Create named roles with specific permissions, then assign them to staff."
        actions={
          <Button onClick={() => navigate("/dashboard/admin/roles/new")}>
            <Plus className="size-4" /> New Role
          </Button>
        }
      />

      {rows === null ? (
        <Card className="overflow-hidden">
          <div className="divide-y divide-border/60">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-4">
                <div className="size-9 shrink-0 animate-pulse rounded-lg bg-muted" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3.5 w-40 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-56 max-w-full animate-pulse rounded bg-muted" />
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : rows.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 py-16 text-center">
          <ShieldCheck className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">No roles yet</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Create a role (e.g. Support, Finance, Ops) with just the permissions it needs, then
            assign it when adding staff.
          </p>
          <Button className="mt-2" onClick={() => navigate("/dashboard/admin/roles/new")}>
            <Plus className="size-4" /> New Role
          </Button>
        </Card>
      ) : (
        <>
          {/* Desktop — table */}
          <Card className="hidden overflow-hidden md:block">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Role</th>
                    <th className="px-4 py-3 font-medium">Access</th>
                    <th className="px-4 py-3 font-medium">Staff</th>
                    <th className="px-4 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((r) => {
                    const secLabels = roleSections(r.permissions, sections);
                    return (
                      <tr
                        key={r.id}
                        onClick={() => navigate(`/dashboard/admin/roles/${r.id}`)}
                        className="cursor-pointer border-b border-border/60 last:border-0 transition-colors hover:bg-primary-tint-soft"
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-tint text-primary">
                              <ShieldCheck className="size-4" />
                            </span>
                            <div className="min-w-0">
                              <p className="truncate font-medium">{r.name}</p>
                              {r.description && (
                                <p className="truncate text-xs text-muted-foreground">{r.description}</p>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">{renderAccess(secLabels)}</td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                            <Users className="size-4" />
                            <span className="tabular-nums">{r.memberCount}</span>
                          </span>
                        </td>
                        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                          {renderActions(r)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Mobile — cards */}
          <div className="space-y-3 md:hidden">
            {pageRows.map((r) => {
              const secLabels = roleSections(r.permissions, sections);
              return (
                <DataCard
                  key={r.id}
                  onClick={() => navigate(`/dashboard/admin/roles/${r.id}`)}
                >
                  <DataCardHeader
                    lead={<DataCardAvatar>{roleInitials(r.name)}</DataCardAvatar>}
                    title={r.name}
                    subtitle={r.description || undefined}
                    actions={renderActions(r)}
                  />
                  <DataCardPills>{renderAccess(secLabels)}</DataCardPills>
                  <DataCardGrid>
                    <CardField label="Staff">
                      <span className="inline-flex items-center gap-1.5">
                        <Users className="size-4 text-muted-foreground" />
                        <span className="tabular-nums">{r.memberCount}</span>
                      </span>
                    </CardField>
                  </DataCardGrid>
                </DataCard>
              );
            })}
          </div>
        </>
      )}

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        noun="roles"
      />

      {/* Delete confirm */}
      <ConfirmDeleteDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        resourceType="role"
        resourceName={toDelete?.name ?? ""}
        onConfirm={confirmDelete}
        description={
          toDelete?.memberCount
            ? `This role is assigned to ${toDelete.memberCount} staff member${
                toDelete.memberCount === 1 ? "" : "s"
              } — reassign them first or the delete will be rejected.`
            : undefined
        }
      />
    </div>
  );
}
