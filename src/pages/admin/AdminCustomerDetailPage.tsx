import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
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
import {
  PageHeaderSkeleton,
  CardSkeleton,
  TableSkeleton,
} from "@/components/ui/skeleton";
import { api, ApiError, type CustomerDetail } from "@/lib/api";
import { useAuthStore } from "@/stores/useAuthStore";
import { useLiveTick } from "@/hooks/useLiveData";
import { CustomerDetailBody } from "./CustomerDetailBody";
import { CustomerDiscountCard } from "./CustomerDiscountCard";
import { isAdminRole } from "@/lib/roles";

export default function AdminCustomerDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  // Suspend/reactivate need `customers.edit`; buttons omitted when denied and `moderate()` no-ops too.
  const canEdit = useAuthStore((s) => s.hasPermission)("customers.edit");
  const [data, setData] = useState<CustomerDetail | null>(null);
  const [busy, setBusy] = useState(false);
  // Which moderation action the admin is confirming (null = no dialog open).
  const [confirm, setConfirm] = useState<"suspend" | "reactivate" | null>(null);
  const [reason, setReason] = useState("");

  async function load(silent = false) {
    try {
      const res = await api.admin.customerDetail(id);
      setData(res);
    } catch (e) {
      if (!silent) toast.error(e instanceof ApiError ? e.message : "Failed to load customer");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Live refresh: silently re-pull this customer's calls/usage/status each tick.
  const liveTick = useLiveTick();
  useEffect(() => {
    if (liveTick > 0) void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveTick]);

  async function moderate() {
    if (!confirm || !canEdit) return;
    const action = confirm;
    setBusy(true);
    try {
      await (action === "suspend"
        ? api.admin.suspendCustomer(id, reason.trim() || undefined)
        : api.admin.reactivateCustomer(id));
      toast.success(action === "suspend" ? "Account suspended" : "Account reactivated");
      setConfirm(null);
      setReason("");
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

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

  const { customer, billing } = data;

  return (
    <div>
      <button
        onClick={() => navigate("/dashboard/admin/customers")}
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Back to customers
      </button>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader title={customer.fullName} subtitle={customer.email} />
        {!isAdminRole(customer.role) && (
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            {/* No "Login as Customer" here — impersonation is PIN-gated behind ImpersonationEmojiTrigger. */}
            {canEdit &&
              (billing.subscriptionStatus === "suspended" ? (
                <Button
                  className="flex-1 sm:flex-none"
                  onClick={() => setConfirm("reactivate")}
                  disabled={busy}
                >
                  Reactivate account
                </Button>
              ) : (
                <Button
                  variant="danger"
                  className="flex-1 sm:flex-none"
                  onClick={() => setConfirm("suspend")}
                  disabled={busy}
                >
                  Suspend account
                </Button>
              ))}
          </div>
        )}
      </div>

      <CustomerDetailBody
        data={data}
        afterAgent={<CustomerDiscountCard userId={customer.id} customerName={customer.fullName || "this customer"} />}
      />

      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setConfirm(null);
            setReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm === "reactivate" ? "Reactivate account" : "Suspend account"}
            </DialogTitle>
            <DialogDescription>
              {confirm === "reactivate" ? (
                <>
                  This restores access for{" "}
                  <span className="font-medium text-foreground">{customer.fullName}</span>. They'll be
                  able to sign in again and their AI receptionist will come back online. We'll email
                  them to confirm.
                </>
              ) : (
                <>
                  This immediately locks{" "}
                  <span className="font-medium text-foreground">{customer.fullName}</span> out of their
                  account. They'll be signed out, won't be able to log back in, and their AI will stop
                  answering calls. We'll email them that the account was suspended.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          {confirm === "suspend" && (
            <div className="space-y-2">
              <Label htmlFor="suspend-reason">Reason (optional)</Label>
              <Textarea
                id="suspend-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Shared with the customer in the suspension email."
                disabled={busy}
              />
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setConfirm(null);
                setReason("");
              }}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant={confirm === "reactivate" ? "primary" : "danger"}
              onClick={moderate}
              disabled={busy}
            >
              {busy && <Loader2 className="animate-spin" />}
              {confirm === "reactivate" ? "Reactivate account" : "Suspend account"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
