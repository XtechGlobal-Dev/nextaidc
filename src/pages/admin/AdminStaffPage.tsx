import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Pencil, Plus, ShieldCheck, Trash2, UserCog } from "lucide-react";
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
import { api, ApiError, type StaffMember } from "@/lib/api";
import { useLiveTick } from "@/hooks/useLiveData";
import { usePagination } from "@/hooks/usePagination";
import { formatDate } from "@/lib/utils";

/** Stable stand-in for the pre-load `null`, so paging doesn't re-slice each render. */
const EMPTY_STAFF: StaffMember[] = [];

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

export default function AdminStaffPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<StaffMember[] | null>(null);
  const [toDelete, setToDelete] = useState<StaffMember | null>(null);

  const {
    page,
    pageSize,
    pageItems: pageRows,
    total,
    setPage,
    setPageSize,
  } = usePagination(rows ?? EMPTY_STAFF);

  // Re-runs on each live tick. Background refreshes (liveTick > 0) keep existing
  // rows on failure and stay quiet, so a transient error never clears the list.
  const liveTick = useLiveTick();
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const list = await api.admin.staff.list();
        if (active) setRows(list);
      } catch (e) {
        if (liveTick === 0) {
          toast.error(e instanceof ApiError ? e.message : "Failed to load staff");
          if (active) setRows([]);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [liveTick]);

  const roleBadge = (s: StaffMember) =>
    s.roleName ? (
      <Badge variant="primary" className="gap-1">
        <ShieldCheck className="size-3" /> {s.roleName}
      </Badge>
    ) : s.permissions.length > 0 ? (
      <Badge variant="neutral">Custom</Badge>
    ) : (
      <span className="text-xs text-muted-foreground">No role</span>
    );

  const renderActions = (s: StaffMember) => (
    <div className="flex items-center justify-end gap-1">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => navigate(`/dashboard/admin/staff/${s.id}`)}
        aria-label={`Edit ${s.fullName}`}
      >
        <Pencil className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="text-danger hover:bg-danger-tint hover:text-danger"
        onClick={() => setToDelete(s)}
        aria-label={`Delete ${s.fullName}`}
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  );

  async function confirmDelete() {
    if (!toDelete) return;
    await api.admin.staff.remove(toDelete.id);
    setRows((prev) => (prev ?? []).filter((r) => r.id !== toDelete.id));
    toast.success(`${toDelete.fullName} removed`);
  }

  return (
    <div>
      <PageHeader
        title="Staff"
        subtitle="Manage staff members and their admin permissions."
        actions={
          <Button onClick={() => navigate("/dashboard/admin/staff/new")}>
            <Plus className="size-4" /> New Staff Member
          </Button>
        }
      />

      {rows === null ? (
        <Card className="overflow-hidden">
          <div className="border-b border-border px-4 py-3">
            <div className="h-4 w-32 animate-pulse rounded bg-muted" />
          </div>
          <div className="divide-y divide-border/60">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3.5">
                <div className="size-9 shrink-0 animate-pulse rounded-full bg-muted" />
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
          <UserCog className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">No staff members yet</p>
          <p className="text-sm text-muted-foreground">
            Add staff to give them limited admin access.
          </p>
          <Button className="mt-2" onClick={() => navigate("/dashboard/admin/staff/new")}>
            <Plus className="size-4" /> New Staff Member
          </Button>
        </Card>
      ) : (
        <>
          {/* Desktop — table (md and up) */}
          <Card className="hidden overflow-hidden md:block">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Staff Member</th>
                    <th className="px-4 py-3 font-medium">Role</th>
                    <th className="px-4 py-3 font-medium">Joined</th>
                    <th className="px-4 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((s) => {
                    return (
                      <tr
                        key={s.id}
                        onClick={() => navigate(`/dashboard/admin/staff/${s.id}`)}
                        className="cursor-pointer border-b border-border/60 last:border-0 transition-colors hover:bg-primary-tint-soft"
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-tint text-xs font-semibold text-primary">
                              {initials(s.fullName)}
                            </span>
                            <div className="min-w-0">
                              <p className="truncate font-medium">{s.fullName}</p>
                              <p className="truncate text-xs text-muted-foreground">{s.email}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">{roleBadge(s)}</td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {formatDate(s.createdAt)}
                        </td>
                        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                          {renderActions(s)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Mobile — cards (below md) */}
          <div className="space-y-3 md:hidden">
            {pageRows.map((s) => (
              <DataCard key={s.id} onClick={() => navigate(`/dashboard/admin/staff/${s.id}`)}>
                <DataCardHeader
                  lead={<DataCardAvatar>{initials(s.fullName)}</DataCardAvatar>}
                  title={s.fullName}
                  subtitle={s.email}
                  actions={renderActions(s)}
                />
                <DataCardPills>{roleBadge(s)}</DataCardPills>
                <DataCardGrid>
                  <CardField label="Joined">{formatDate(s.createdAt)}</CardField>
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
        noun="staff members"
      />

      {/* Delete confirm */}
      <ConfirmDeleteDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        resourceType="staff member"
        resourceName={toDelete?.fullName ?? ""}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
