import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Ban, RotateCcw, Trash2, UserX } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDeleteDialog } from "@/components/ui/ConfirmDeleteDialog";
import { PageHeaderSkeleton, CardSkeleton, TableSkeleton } from "@/components/ui/skeleton";
import { api, ApiError, type PlatformCustomerDetail } from "@/lib/api";
import { useLiveTick } from "@/hooks/useLiveData";
import { formatDate } from "@/lib/utils";
import { CustomerDetailBody, Field } from "./CustomerDetailBody";

// One main-domain customer (docs/brand-as-customer-plan.md): the account row from Main, and the owner's
// deep dive from the customer's own database. Once their Brand Admin request is approved the account is a
// brand, and this page hands over to the brand's page.

const LIST = "/dashboard/admin/platform-customers";

export default function AdminPlatformCustomerDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<PlatformCustomerDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function load(silent = false) {
    try {
      const res = await api.super.platformCustomers.get(id);
      if (res.convertedToBrand) {
        toast.info(`${res.account.businessName || "This customer"} is a brand now`);
        navigate(`/dashboard/admin/brands/${res.account.id}`, { replace: true });
        return;
      }
      setData(res);
    } catch (e) {
      if (silent) return;
      toast.error(e instanceof ApiError ? e.message : "Couldn't load this customer");
      if (e instanceof ApiError && e.status === 404) navigate(LIST, { replace: true });
    }
  }

  useEffect(() => {
    setData(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Live refresh: silently re-pull calls/usage/status each tick.
  const liveTick = useLiveTick();
  useEffect(() => {
    if (liveTick > 0) void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveTick]);

  if (!data) {
    return (
      <div>
        <PageHeaderSkeleton />
        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <CardSkeleton rows={3} />
          <CardSkeleton rows={3} />
          <CardSkeleton rows={2} />
        </div>
        <CardSkeleton rows={2} className="mt-4" />
        <TableSkeleton cols={5} rows={4} />
      </div>
    );
  }

  const { account, owner, detail } = data;
  const name = account.businessName || owner?.fullName || owner?.email || "Customer";

  // The same account-level lock as the list: sign-in and every open session are refused while suspended.
  const toggle = async () => {
    const suspend = account.status === "active";
    if (suspend && !window.confirm(`Suspend ${name}? They are signed out and can't sign in until you restore them.`)) {
      return;
    }
    setBusy(true);
    try {
      if (suspend) await api.super.platformCustomers.suspend(account.id);
      else await api.super.platformCustomers.reactivate(account.id);
      toast.success(suspend ? "Account suspended" : "Account restored");
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't update the account");
    } finally {
      setBusy(false);
    }
  };

  // Throws on failure so ConfirmDeleteDialog surfaces the error and stays open.
  const destroy = async () => {
    await api.super.platformCustomers.remove(account.id);
    toast.success(`${name} deleted, along with its database`);
    navigate(LIST, { replace: true });
  };

  return (
    <div>
      <button
        onClick={() => navigate(LIST)}
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Back to platform customers
      </button>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title={name}
          subtitle={owner ? [owner.fullName !== name ? owner.fullName : "", owner.email].filter(Boolean).join(" · ") : undefined}
        />
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
          {(account.status === "active" || account.status === "suspended") && (
            <Button
              variant={account.status === "active" ? "danger" : "primary"}
              className="w-full sm:w-auto"
              disabled={busy}
              onClick={() => void toggle()}
            >
              {account.status === "active" ? <Ban className="size-4" /> : <RotateCcw className="size-4" />}
              {account.status === "active" ? "Suspend account" : "Restore account"}
            </Button>
          )}
          <Button variant="outline" className="w-full text-danger sm:w-auto" disabled={busy} onClick={() => setDeleting(true)}>
            <Trash2 className="size-4" /> Delete account
          </Button>
        </div>
      </div>

      <ConfirmDeleteDialog
        open={deleting}
        onOpenChange={setDeleting}
        resourceType="customer"
        resourceName={name}
        title="Delete account"
        description="Their subscription is cancelled, their AI agent and phone number are released, and the account is removed with its database. They can sign up again with the same email afterwards."
        onConfirm={destroy}
      />

      <Card className="mt-5 p-5 sm:mt-0">
        <h3 className="mb-4 border-b border-border/60 pb-2.5 text-base font-semibold">Account</h3>
        <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Status</p>
            <span className="mt-1 flex flex-wrap items-center gap-1.5">
              {account.status === "suspended" ? (
                <Badge variant="danger">Suspended</Badge>
              ) : account.status === "active" ? (
                <Badge variant="success">Active</Badge>
              ) : (
                <Badge variant="neutral">{account.status}</Badge>
              )}
              {account.downgradedAt && <Badge variant="warning">Former brand</Badge>}
            </span>
          </div>
          <Field label="Signed up" value={formatDate(account.createdAt)} />
          <Field label="First active" value={account.activatedAt ? formatDate(account.activatedAt) : ""} />
          <Field label="Downgraded" value={account.downgradedAt ? formatDate(account.downgradedAt) : ""} />
        </div>
      </Card>

      {detail ? (
        // The body brings its own mobile top margin (it normally sits right under the header).
        <div className="-mt-1 sm:mt-4">
          <CustomerDetailBody data={detail} />
        </div>
      ) : (
        <Card className="mt-4 flex flex-col items-center gap-2 py-14 text-center">
          <UserX className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">
            {owner ? "Couldn't read this customer's account" : "No account in this sign-up yet"}
          </p>
          <p className="max-w-md text-sm text-muted-foreground">
            {data.detailError ||
              "The sign-up hasn't finished creating its account. Abandoned sign-ups are cleared automatically."}
          </p>
        </Card>
      )}
    </div>
  );
}
