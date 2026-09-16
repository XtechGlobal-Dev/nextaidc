import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Crown } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { ENTITLEMENTS_CACHE_KEY, cachedCallTransferDepartments } from "@/lib/planFeatures";
import { HumanTransferCard } from "@/components/transfer/HumanTransferCard";

/** Human Call Transfer page. The plan gate is a department COUNT (0 = locked, N = cap, enforced server-side); an excluded plan still gets the page with an upgrade prompt rather than a card that 403s. */
export default function HumanTransferPage() {
  const navigate = useNavigate();

  // Seed from the cached entitlement (Infinity until known) so a revisit never flashes a false "locked".
  const [maxDepartments, setMaxDepartments] = useState(cachedCallTransferDepartments);
  useEffect(() => {
    let active = true;
    api.notifications
      .channels()
      .then((c) => {
        if (!active) return;
        // An API that predates the transfer gate simply omits the field — read
        // that as unlocked rather than locking a feature the plan still allows.
        setMaxDepartments(
          typeof c.callTransferDepartments === "number"
            ? c.callTransferDepartments
            : Number.POSITIVE_INFINITY,
        );
        try {
          localStorage.setItem(ENTITLEMENTS_CACHE_KEY, JSON.stringify(c));
        } catch {
          /* ignore unavailable storage */
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const included = maxDepartments > 0;

  return (
    <div>
      <PageHeader
        title="Call Transfer"
        subtitle="When a caller asks for a real person, the AI transfers the call to your number."
      />

      <div className="mt-6 flex flex-col gap-5">
        {!included && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-premium/40 bg-premium-tint px-4 py-3">
            <div className="flex items-center gap-2.5 text-premium">
              <Crown className="size-5 shrink-0" />
              <p className="text-sm font-medium">
                Call Transfer is a premium feature — upgrade your plan to switch it on.
              </p>
            </div>
            <Button size="sm" onClick={() => navigate("/dashboard/plans")}>
              <Crown className="size-4" /> Upgrade
            </Button>
          </div>
        )}
        <HumanTransferCard locked={!included} maxDepartments={maxDepartments} />
      </div>
    </div>
  );
}
