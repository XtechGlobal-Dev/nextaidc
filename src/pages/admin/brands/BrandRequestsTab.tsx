import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Copy, CreditCard, Globe, Inbox, Mail, Phone, Wand2, X } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DataCard, DataCardGrid, DataCardHeader, CardField } from "@/components/ui/data-card";
import { api, ApiError, type BrandRequest } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";
import { BrandMark } from "@/components/brand/BrandLookPickers";

/** The applicant's mark: their logo, or their initial on the palette they picked (the platform's default
 *  when they didn't pick one). */
function RequestMark({ r }: { r: BrandRequest }) {
  return (
    <BrandMark
      logoUrl={r.logoLightUrl}
      name={r.brandName}
      primary={r.primaryColor || "#2C76ED"}
      accent={r.accentColor || "#7C5CFC"}
      className="size-9 rounded-lg text-xs"
    />
  );
}

// The Requested tab: brands that asked to be set up from the public "Set up your
// brand" page. "Complete setup" opens the create wizard pre-filled from the
// request; the super admin picks the settings, permissions and plans and launches it.

export type RequestFilter = "open" | "approved" | "declined";

const FILTERS: { id: RequestFilter; label: string }[] = [
  { id: "open", label: "Waiting" },
  { id: "approved", label: "Set up" },
  { id: "declined", label: "Declined" },
];

export function BrandRequestsTab({
  filter,
  onFilter,
  rows,
  counts,
  error,
  onDeclined,
}: {
  filter: RequestFilter;
  onFilter: (f: RequestFilter) => void;
  /** Null while loading. */
  rows: BrandRequest[] | null;
  counts: Record<RequestFilter, number>;
  error: string;
  onDeclined: (r: BrandRequest) => void;
}) {
  const navigate = useNavigate();
  const [toDecline, setToDecline] = useState<BrandRequest | null>(null);

  const publicUrl = `${window.location.origin}/brand-setup`;
  const complete = (r: BrandRequest) => navigate(`/dashboard/admin/brands/new?request=${r.id}`);

  const renderActions = (r: BrandRequest) =>
    r.status === "approved" && r.brandId ? (
      <Button variant="outline" size="sm" onClick={() => navigate(`/dashboard/admin/brands/${r.brandId}`)}>
        Open brand <ArrowRight className="size-3.5" />
      </Button>
    ) : r.status === "declined" ? null : (
      <div className="flex items-center justify-end gap-1.5">
        <Button size="sm" onClick={() => complete(r)}>
          <Wand2 className="size-3.5" /> Complete setup
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-danger hover:bg-danger-tint hover:text-danger"
          onClick={() => setToDecline(r)}
          aria-label={`Decline ${r.brandName}`}
          title="Decline"
        >
          <X className="size-4" />
        </Button>
      </div>
    );

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-xl border border-border bg-card p-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => onFilter(f.id)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                filter === f.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {f.label}
              <span className="ml-1.5 tabular-nums opacity-80">{counts[f.id]}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(publicUrl).then(
              () => toast.success("Request link copied"),
              () => toast.error("Couldn't copy the link"),
            );
          }}
          className="inline-flex max-w-full items-center gap-1.5 truncate text-xs text-muted-foreground hover:text-primary"
          title="Copy the public request link"
        >
          <Copy className="size-3.5 shrink-0" />
          <span className="truncate font-mono">{publicUrl.replace(/^https?:\/\//, "")}</span>
        </button>
      </div>

      {error ? (
        <Card className="p-6 text-sm text-danger">{error}</Card>
      ) : rows === null ? (
        <Card className="overflow-hidden">
          <div className="divide-y divide-border/60">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-4">
                <div className="flex-1 space-y-1.5">
                  <div className="h-3.5 w-40 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-56 max-w-full animate-pulse rounded bg-muted" />
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : rows.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 px-6 py-14 text-center">
          <Inbox className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">
            {filter === "open" ? "No brands waiting for setup" : filter === "approved" ? "Nothing set up from a request yet" : "No declined requests"}
          </p>
          {filter === "open" && (
            <p className="max-w-md text-sm text-muted-foreground">
              When someone asks to launch their own brand from the &ldquo;Set up your brand&rdquo; page,
              their request lands here for you to complete.
            </p>
          )}
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
                    <th className="px-4 py-3 font-medium">Contact</th>
                    <th className="px-4 py-3 font-medium">{filter === "open" ? "Requested" : "Reviewed"}</th>
                    <th className="px-4 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-border/60 align-top last:border-0">
                      <td className="max-w-[300px] px-4 py-3">
                        <div className="flex gap-3">
                          <RequestMark r={r} />
                          <div className="min-w-0">
                            <p className="truncate font-medium">{r.brandName}</p>
                            <p className="truncate font-mono text-xs text-muted-foreground">{r.slug}</p>
                            {r.customDomain && (
                              <p
                                className="flex items-center gap-1 truncate font-mono text-xs text-muted-foreground"
                                title="Their own domain"
                              >
                                <Globe className="size-3 shrink-0" /> {r.customDomain}
                              </p>
                            )}
                            {r.tagline && (
                              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{r.tagline}</p>
                            )}
                            {r.status === "declined" && r.declineReason && (
                              <p className="mt-1 line-clamp-2 text-xs text-danger">{r.declineReason}</p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="max-w-[240px] px-4 py-3">
                        <p className="truncate">{r.contactName}</p>
                        <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                          <Mail className="size-3 shrink-0" /> {r.email}
                        </p>
                        {r.phone && (
                          <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                            <Phone className="size-3 shrink-0" /> {r.phone}
                          </p>
                        )}
                        {r.card && (
                          <p className="flex items-center gap-1 truncate text-xs text-muted-foreground" title="Charged when you complete setup">
                            <CreditCard className="size-3 shrink-0" /> Card saved
                          </p>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                        {timeAgo(r.status === "pending" || r.status === "approving" ? r.createdAt : (r.reviewedAt ?? r.createdAt))}
                        {r.status === "approving" && (
                          <Badge variant="warning" className="ml-2 text-[10px]">
                            Setting up
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">{renderActions(r)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Mobile — cards */}
          <div className="space-y-3 md:hidden">
            {rows.map((r) => (
              <DataCard key={r.id}>
                <DataCardHeader
                  lead={<RequestMark r={r} />}
                  title={r.brandName}
                  subtitle={r.customDomain ? `${r.slug} · ${r.customDomain}` : r.slug}
                />
                <DataCardGrid>
                  <CardField label="Contact">{r.contactName}</CardField>
                  <CardField label="Email">
                    <span className="break-all">{r.email}</span>
                  </CardField>
                  <CardField label={filter === "open" ? "Requested" : "Reviewed"}>
                    {timeAgo(filter === "open" ? r.createdAt : (r.reviewedAt ?? r.createdAt))}
                  </CardField>
                </DataCardGrid>
                {r.status !== "declined" && <div className="mt-3 flex justify-end">{renderActions(r)}</div>}
              </DataCard>
            ))}
          </div>
        </>
      )}

      <DeclineDialog
        request={toDecline}
        onClose={() => setToDecline(null)}
        onDeclined={(r) => {
          setToDecline(null);
          onDeclined(r);
        }}
      />
    </div>
  );
}

function DeclineDialog({
  request,
  onClose,
  onDeclined,
}: {
  request: BrandRequest | null;
  onClose: () => void;
  onDeclined: (r: BrandRequest) => void;
}) {
  const [reason, setReason] = useState("");
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);

  async function decline() {
    if (!request) return;
    setBusy(true);
    try {
      const res = await api.super.brandRequests.decline(request.id, { reason, notify });
      toast.success(`${request.brandName} declined${notify ? " — the applicant has been emailed" : ""}`);
      setReason("");
      onDeclined(res);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't decline the request");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Decline {request?.brandName}?</DialogTitle>
          <DialogDescription>
            Nothing has been created for this request, so there is nothing to clean up. Their
            password is discarded.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="decline-reason" className="text-sm font-medium">
              Reason <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="decline-reason"
              rows={3}
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Shown to the applicant in the email."
              className="mt-2"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={notify} onCheckedChange={(v) => setNotify(v === true)} />
            Email {request?.email ?? "the applicant"}
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void decline()} disabled={busy}>
            Decline request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
