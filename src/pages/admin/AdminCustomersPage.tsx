import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Download, ExternalLink, Eye, MoreHorizontal, Search, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDeleteDialog } from "@/components/ui/ConfirmDeleteDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TableSkeleton } from "@/components/ui/skeleton";
import { Pagination } from "@/components/ui/pagination";
import { api, ApiError, type Customer } from "@/lib/api";
import { useAuthStore } from "@/stores/useAuthStore";
import { useLiveTick } from "@/hooks/useLiveData";
import { usePagination } from "@/hooks/usePagination";
import { formatDateDMY } from "@/lib/utils";
import { toCsv, downloadCsv, datedCsvName, type CsvColumn } from "@/lib/csv";
import {
  STATUS_META,
  STATUS_ORDER,
  planLabel,
  statusKey,
  type StatusKey,
  type StatusVariant,
} from "@/lib/customerStatus";
import { cn, formatDate } from "@/lib/utils";
import { PlanPill } from "./PlanPill";
import { isAdminRole, isAdminTeamRole } from "@/lib/roles";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Avatar with presence dot. `online` = app open right now (active event stream), not "last seen", so offline shows no dot.
function CustomerAvatar({
  name,
  online,
  size = "sm",
}: {
  name: string;
  online: boolean;
  size?: "sm" | "lg";
}) {
  return (
    <span className="relative shrink-0">
      <span
        className={cn(
          "flex items-center justify-center rounded-full bg-primary-tint font-semibold text-primary",
          size === "lg" ? "size-11 text-sm" : "size-9 text-xs",
        )}
      >
        {initials(name)}
      </span>
      {online && (
        <span
          title={`${name} is online now`}
          className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-card bg-success"
        >
          <span className="sr-only">Online now</span>
        </span>
      )}
    </span>
  );
}


/** Map a customer's subscription state to a badge label + colour. */
function statusBadge(c: Customer): { label: string; variant: StatusVariant } {
  const { label, variant } = STATUS_META[statusKey(c)];
  return { label, variant };
}

function RoleBadge({ role }: { role: string }) {
  return (
    <Badge
      variant={
        isAdminTeamRole(role) ? "primary" : role === "RESELLER" ? "premium" : "neutral"
      }
    >
      {role}
    </Badge>
  );
}

function AssistantLink({ id }: { id: string | null }) {
  if (!id) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <a
      href={`https://dashboard.vapi.ai/assistants/${id}?tab=assistant`}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={`Open ${id} in Vapi`}
      className="inline-flex items-center gap-1.5 font-mono text-xs text-primary hover:underline"
    >
      {id.slice(0, 8)}…
      <ExternalLink className="size-3.5" />
    </a>
  );
}

/** Label + value stack used inside the mobile customer cards. */
function CardField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-0.5 truncate text-sm font-medium text-foreground">{children}</div>
    </div>
  );
}

export default function AdminCustomersPage() {
  const navigate = useNavigate();
  const isAdmin = useAuthStore((s) => isAdminRole(s.user?.role));
  // Delete needs `customers.delete`; menu item omitted from the DOM when denied and the handler no-ops.
  const canDelete = useAuthStore((s) => s.hasPermission)("customers.delete");
  const [rows, setRows] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusKey | "all">("all");
  const [planFilter, setPlanFilter] = useState<string>("all");
  const [toDelete, setToDelete] = useState<Customer | null>(null);

  // `silent` background refreshes (driven by the live heartbeat) skip the skeleton
  // and swallow errors, so the table quietly stays in sync without a reload.
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await api.admin.customers();
      setRows(data);
    } catch (e) {
      if (!silent) toast.error(e instanceof ApiError ? e.message : "Failed to load customers");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const liveTick = useLiveTick();
  const didInit = useRef(false);
  useEffect(() => {
    // First run per mount is a full load, later ticks are silent. Per-mount ref, since the global tick survives navigation.
    if (!didInit.current) {
      didInit.current = true;
      void load();
    } else {
      void load(true);
    }
  }, [liveTick, load]);

  /** Plans actually present in the data — no point offering a plan nobody is on. */
  const planOptions = useMemo(
    () => [...new Set(rows.map(planLabel))].sort((a, b) => a.localeCompare(b)),
    [rows],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((c) => {
      if (statusFilter !== "all" && statusKey(c) !== statusFilter) return false;
      if (planFilter !== "all" && planLabel(c) !== planFilter) return false;
      if (!q) return true;
      return `${c.fullName} ${c.email} ${c.businessName} ${planLabel(c)} ${c.role} ${c.callCount}`
        .toLowerCase()
        .includes(q);
    });
  }, [rows, search, statusFilter, planFilter]);

  const filtersActive = statusFilter !== "all" || planFilter !== "all" || search.trim() !== "";

  function resetFilters() {
    setSearch("");
    setStatusFilter("all");
    setPlanFilter("all");
  }

  // Exports the filtered set on purpose — clear filters to get everything.
  function exportCsv() {
    if (!filtered.length) {
      toast.error("Nothing to export — no customers match these filters.");
      return;
    }
    const columns: CsvColumn<Customer>[] = [
      { header: "Name", value: (c) => c.fullName },
      { header: "Email", value: (c) => c.email },
      { header: "Business", value: (c) => c.businessName },
      { header: "Plan", value: planLabel },
      { header: "Status", value: (c) => STATUS_META[statusKey(c)].label },
      { header: "Role", value: (c) => c.role },
      { header: "Calls", value: (c) => c.callCount },
      { header: "Number activated", value: (c) => (c.numberActivated ? "Yes" : "No") },
      { header: "Emails", value: (c) => (c.emailOptOutAt ? "Unsubscribed" : "Subscribed") },
      { header: "Joined", value: (c) => formatDateDMY(c.createdAt) },
    ];
    downloadCsv(datedCsvName("customers"), toCsv(columns, filtered));
    toast.success(`Exported ${filtered.length} customer${filtered.length === 1 ? "" : "s"}`);
  }

  // `resetKey` snaps back to page 1 whenever the search narrows the list; an
  // out-of-range page after a delete is clamped by the hook itself.
  const {
    page,
    pageSize,
    pageItems: paged,
    total,
    setPage,
    setPageSize,
  } = usePagination(filtered, { resetKey: `${search}|${statusFilter}|${planFilter}` });

  // Throws on failure so ConfirmDeleteDialog surfaces the error and stays open;
  // it owns the loading state and closes on success.
  async function confirmDelete() {
    if (!toDelete || !canDelete) return;
    const c = toDelete;
    await api.admin.deleteCustomer(c.id);
    setRows((prev) => prev.filter((r) => r.id !== c.id));
    toast.success(`${c.fullName} deleted`);
  }

  const renderActions = (c: Customer) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Actions for ${c.fullName}`}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => navigate(`/dashboard/admin/customers/${c.id}`)}>
          <Eye /> View details
        </DropdownMenuItem>
        {/* No "Login as Customer" here — impersonation is PIN-gated on the detail page (ImpersonationEmojiTrigger). */}
        {canDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-danger focus:bg-danger-tint focus:text-danger"
              onSelect={() => setToDelete(c)}
            >
              <Trash2 /> Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div>
      <PageHeader
        title="Customers"
        subtitle="Manage everyone using your AI receptionist."
        actions={
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-sm text-muted-foreground shadow-[var(--shadow-soft)]">
            <Users className="size-4 text-primary" />
            {/* Once a filter narrows the list, the population size on its own is
                misleading — show what's actually on screen against it. */}
            {filtersActive ? (
              <>
                <span className="font-semibold text-foreground tabular-nums">{filtered.length}</span>
                of {rows.length}
              </>
            ) : (
              <>
                <span className="font-semibold text-foreground tabular-nums">{rows.length}</span>
                total
              </>
            )}
          </span>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-2 rounded-[var(--radius-card)] border border-border bg-card p-3 shadow-[var(--shadow-soft)]">
        <div className="relative min-w-[15rem] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search name, email, business, plan or role…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            aria-label="Search customers"
          />
        </div>

        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as StatusKey | "all")}
        >
          <SelectTrigger className="w-[190px]" aria-label="Filter by status">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {STATUS_ORDER.map((key) => (
              <SelectItem key={key} value={key}>
                {STATUS_META[key].label}
                {STATUS_META[key].hint ? (
                  <span className="ml-1 text-xs text-muted-foreground">
                    — {STATUS_META[key].hint}
                  </span>
                ) : null}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={planFilter} onValueChange={setPlanFilter}>
          <SelectTrigger className="w-[150px]" aria-label="Filter by plan">
            <SelectValue placeholder="All plans" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All plans</SelectItem>
            {planOptions.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {filtersActive && (
          <Button variant="ghost" size="sm" onClick={resetFilters}>
            Reset
          </Button>
        )}

        <span className="ml-auto hidden h-6 w-px bg-border sm:block" aria-hidden />

        <Button variant="outline" size="sm" className="gap-2" onClick={exportCsv}>
          <Download className="size-4" />
          Export
          {filtersActive && filtered.length > 0 && (
            <span className="tabular-nums text-muted-foreground">({filtered.length})</span>
          )}
        </Button>
      </div>

      {loading ? (
        <TableSkeleton cols={isAdmin ? 10 : 9} />
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-[var(--radius-card)] border border-border bg-card py-20 text-center shadow-[var(--shadow-soft)]">
          <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Users className="size-6" />
          </span>
          <p className="text-sm font-medium">No customers found</p>
          <p className="text-sm text-muted-foreground">
            {filtersActive
              ? "No one matches these filters."
              : "Customers will appear here once they sign up."}
          </p>
          {filtersActive && (
            <Button variant="outline" size="sm" className="mt-2" onClick={resetFilters}>
              Clear filters
            </Button>
          )}
        </div>
      ) : (
        <>
          {/* Desktop — table (md and up) */}
          <div className="hidden overflow-hidden rounded-[var(--radius-card)] border border-border bg-card shadow-[var(--shadow-soft)] md:block">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Customer</th>
                    <th className="px-4 py-3 font-medium">Business</th>
                    <th className="px-4 py-3 font-medium">Plan</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    {isAdmin && <th className="px-4 py-3 font-medium">Assistant</th>}
                    <th className="px-4 py-3 text-right font-medium">Calls</th>
                    <th className="px-4 py-3 font-medium">Joined</th>
                    <th className="px-4 py-3 font-medium">Role</th>
                    <th className="px-4 py-3 font-medium">Emails</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {paged.map((c) => {
                    const s = statusBadge(c);
                    return (
                      <tr
                        key={c.id}
                        onClick={() => navigate(`/dashboard/admin/customers/${c.id}`)}
                        className={cn(
                          "group cursor-pointer border-b border-border/60 last:border-0 transition-colors hover:bg-primary-tint-soft",
                        )}
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <CustomerAvatar name={c.fullName} online={c.online} />
                            <div className="min-w-0">
                              <p className="truncate font-medium">{c.fullName}</p>
                              <p className="truncate text-xs text-muted-foreground">{c.email}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{c.businessName}</td>
                        <td className="px-4 py-3">
                          <PlanPill name={c.planName} />
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={s.variant}>{s.label}</Badge>
                        </td>
                        {isAdmin && (
                          <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                            <AssistantLink id={c.vapiAssistantId} />
                          </td>
                        )}
                        <td className="px-4 py-3 text-right tabular-nums">{c.callCount}</td>
                        <td className="px-4 py-3 text-muted-foreground">{formatDate(c.createdAt)}</td>
                        <td className="px-4 py-3">
                          <RoleBadge role={c.role} />
                        </td>
                        <td className="px-4 py-3">
                          {c.emailOptOutAt ? (
                            <Badge variant="warning" title={`Unsubscribed ${formatDate(c.emailOptOutAt)}`}>
                              Opted out
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">Subscribed</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                          {renderActions(c)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile — cards (below md) */}
          <div className="space-y-3 md:hidden">
            {paged.map((c) => {
              const s = statusBadge(c);
              return (
                <div
                  key={c.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`/dashboard/admin/customers/${c.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") navigate(`/dashboard/admin/customers/${c.id}`);
                  }}
                  className={cn(
                    "rounded-2xl border border-border bg-card p-4 shadow-[var(--shadow-soft)] transition-colors active:bg-primary-tint-soft",
                  )}
                >
                  {/* Header: avatar + identity + actions */}
                  <div className="flex items-start gap-3">
                    <CustomerAvatar name={c.fullName} online={c.online} size="lg" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold leading-tight">{c.fullName}</p>
                      <p className="truncate text-xs text-muted-foreground">{c.email}</p>
                    </div>
                    <div className="-mr-1 -mt-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                      {renderActions(c)}
                    </div>
                  </div>

                  {/* Pills: plan · status · role */}
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    <PlanPill name={c.planName} />
                    <Badge variant={s.variant}>{s.label}</Badge>
                    <RoleBadge role={c.role} />
                  </div>

                  {/* Meta grid */}
                  <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border/60 pt-3">
                    <CardField label="Business">{c.businessName || "—"}</CardField>
                    <CardField label="Calls">
                      <span className="tabular-nums">{c.callCount}</span>
                    </CardField>
                    <CardField label="Joined">{formatDate(c.createdAt)}</CardField>
                    {isAdmin && (
                      <CardField label="Assistant">
                        <AssistantLink id={c.vapiAssistantId} />
                      </CardField>
                    )}
                    <CardField label="Emails">
                      {c.emailOptOutAt ? (
                        <Badge variant="warning">Opted out</Badge>
                      ) : (
                        <span className="text-xs font-normal text-muted-foreground">Subscribed</span>
                      )}
                    </CardField>
                  </div>
                </div>
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
        noun="customers"
      />

      <ConfirmDeleteDialog
        open={toDelete !== null}
        onOpenChange={(open) => !open && setToDelete(null)}
        resourceType="customer"
        resourceName={toDelete?.fullName ?? ""}
        onConfirm={confirmDelete}
        description="This removes the customer and all of their data — calls, recordings, agent config and billing history."
      />
    </div>
  );
}
