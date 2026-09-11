import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, ExternalLink, Globe, Pencil, Plus, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDeleteDialog } from "@/components/ui/ConfirmDeleteDialog";
import { formatMoney } from "@/lib/currency";
import {
  DataCard,
  DataCardGrid,
  DataCardHeader,
  DataCardPills,
  CardField,
} from "@/components/ui/data-card";
import { Pagination } from "@/components/ui/pagination";
import { usePagination } from "@/hooks/usePagination";
import { api, ApiError, type Brand } from "@/lib/api";
import { StripeUnroutedCard } from "./StripeUnroutedCard";

/** Stable stand-in for the pre-load `null`, so paging doesn't re-slice each render. */
const EMPTY: Brand[] = [];

/** The swatch that makes a brand recognisable at a glance in the list. */
function BrandSwatch({ brand }: { brand: Brand }) {
  return (
    <span
      className="flex size-9 shrink-0 items-center justify-center rounded-lg text-xs font-semibold text-white"
      style={{
        background: `linear-gradient(135deg, ${brand.primaryColor}, ${brand.accentColor})`,
      }}
      aria-hidden
    >
      {brand.name.trim().slice(0, 2).toUpperCase()}
    </span>
  );
}

export default function AdminBrandsPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<Brand[] | null>(null);
  const [toDelete, setToDelete] = useState<Brand | null>(null);

  const { page, pageSize, pageItems, total, setPage, setPageSize } = usePagination(rows ?? EMPTY);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const list = await api.super.brands.list();
        if (active) setRows(list);
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : "Failed to load brands");
        if (active) setRows([]);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Throws on failure so ConfirmDeleteDialog surfaces the error and stays open.
  async function confirmDelete() {
    if (!toDelete) return;
    const res = await api.super.brands.remove(toDelete.id);
    setRows((prev) => (prev ?? []).filter((b) => b.id !== toDelete.id));
    toast.success(
      res.membersDetached > 0
        ? `"${toDelete.name}" deleted — ${res.membersDetached} account${
            res.membersDetached === 1 ? "" : "s"
          } kept and moved to the platform.`
        : `"${toDelete.name}" deleted`,
    );
  }

  const renderActions = (b: Brand) => (
    <div className="flex items-center justify-end gap-1">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => navigate(`/dashboard/admin/brands/${b.id}`)}
        aria-label={`Edit ${b.name}`}
      >
        <Pencil className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="text-danger hover:bg-danger-tint hover:text-danger"
        onClick={() => setToDelete(b)}
        aria-label={`Delete ${b.name}`}
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  );

  /** Where the brand actually answers right now — which is its subdomain until a
   *  vanity domain is verified, so a claimed-but-unpublished domain never reads
   *  as the live address. The pending marker is what tells the operator someone
   *  is still waiting on the client's DNS. */
  const renderAddress = (b: Brand) => (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <Globe className="size-3.5 shrink-0" />
      <span className="truncate">{b.origin?.replace(/^https:\/\//, "") || b.platformHost}</span>
      {b.customDomain && b.domainStatus !== "verified" && (
        <Badge variant="warning" className="shrink-0 text-[10px]">
          DNS pending
        </Badge>
      )}
    </span>
  );

  const renderStatus = (b: Brand) => (
    <Badge
      variant={
        b.status === "active"
          ? "success"
          : b.status === "provisioning"
            ? "warning"
            : b.status === "failed"
              ? "danger"
              : "neutral"
      }
    >
      {b.status === "active"
        ? "Active"
        : b.status === "provisioning"
          ? "Setting up"
          : b.status === "failed"
            ? "Setup failed"
            : "Suspended"}
    </Badge>
  );

  return (
    <div>
      <PageHeader
        title="Brands"
        subtitle="Every white-label tenant: its subdomain, its look, and the senders its customers see."
        actions={
          <Button onClick={() => navigate("/dashboard/admin/brands/new")}>
            <Plus className="size-4" /> New Brand
          </Button>
        }
      />

      {/* Only appears when a Stripe event is waiting for a brand. */}
      <StripeUnroutedCard />

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
          <Building2 className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">No brands yet</p>
          <p className="max-w-md text-sm text-muted-foreground">
            A brand is a second front door to this platform — its own subdomain, logo, colours and
            font, run day to day by its own admin. Their customers never see this platform's name.
          </p>
          <Button className="mt-2" onClick={() => navigate("/dashboard/admin/brands/new")}>
            <Plus className="size-4" /> Create the first brand
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
                    <th className="px-4 py-3 font-medium">Brand</th>
                    <th className="px-4 py-3 font-medium">Address</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Accounts</th>
                    <th className="px-4 py-3 font-medium">Wallet</th>
                    <th className="px-4 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map((b) => (
                    <tr
                      key={b.id}
                      onClick={() => navigate(`/dashboard/admin/brands/${b.id}`)}
                      className="cursor-pointer border-b border-border/60 transition-colors last:border-0 hover:bg-primary-tint-soft"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <BrandSwatch brand={b} />
                          <div className="min-w-0">
                            <p className="truncate font-medium">{b.name}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {b.tagline || `${b.fontStyle} type · ${b.themePreset}`}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="max-w-[220px] px-4 py-3">{renderAddress(b)}</td>
                      <td className="px-4 py-3">{renderStatus(b)}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                          <Users className="size-4" />
                          <span className="tabular-nums">{b.counts?.total ?? 0}</span>
                        </span>
                      </td>
                      <td className="px-4 py-3 tabular-nums">
                        {/* What the platform owes the brand right now — the
                            "who needs paying" glance, per currency. */}
                        {b.walletBalances?.some((w) => w.balanceCents !== 0) ? (
                          b.walletBalances
                            .filter((w) => w.balanceCents !== 0)
                            .map((w) => formatMoney(w.balanceCents, w.currency))
                            .join(" · ")
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        {renderActions(b)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Mobile — cards */}
          <div className="space-y-3 md:hidden">
            {pageItems.map((b) => (
              <DataCard key={b.id} onClick={() => navigate(`/dashboard/admin/brands/${b.id}`)}>
                <DataCardHeader
                  lead={<BrandSwatch brand={b} />}
                  title={b.name}
                  subtitle={b.origin?.replace(/^https:\/\//, "") || b.platformHost}
                  actions={renderActions(b)}
                />
                <DataCardPills>{renderStatus(b)}</DataCardPills>
                <DataCardGrid>
                  <CardField label="Admins">
                    <span className="tabular-nums">{b.counts?.admins ?? 0}</span>
                  </CardField>
                  <CardField label="Customers">
                    <span className="tabular-nums">{b.counts?.customers ?? 0}</span>
                  </CardField>
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
        noun="brands"
      />

      <ConfirmDeleteDialog
        open={toDelete !== null}
        onOpenChange={(open) => !open && setToDelete(null)}
        resourceType="brand"
        resourceName={toDelete?.name ?? ""}
        onConfirm={confirmDelete}
        description={
          <>
            Its subdomain stops resolving immediately. The{" "}
            <strong>{toDelete?.counts?.total ?? 0}</strong> account
            {(toDelete?.counts?.total ?? 0) === 1 ? "" : "s"} inside it are{" "}
            <strong>not</strong> deleted — they keep working as platform-level accounts. To take a
            brand offline without losing its address, set its status to Suspended instead.
          </>
        }
      />

      {rows !== null && rows.length > 0 && (
        <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
          <ExternalLink className="size-3.5" />
          Point each subdomain (and any custom domain) at this deployment in DNS before handing it
          to a brand's admin.
        </p>
      )}
    </div>
  );
}
