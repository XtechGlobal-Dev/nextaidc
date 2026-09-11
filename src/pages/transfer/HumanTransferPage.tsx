import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Crown } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { ENTITLEMENTS_CACHE_KEY, cachedCallTransferDepartments } from "@/lib/planFeatures";
import { HumanTransferCard } from "@/components/transfer/HumanTransferCard";

/**
 * Human Call Transfer — standalone tenant page (sidebar: under Call Forwarding).
 * Callers who ask for a person are routed by department: the AI asks which one
 * they need, then warm-transfers to that department's number.
 *
 * Gated by the plan's transfer allowance, which is a COUNT rather than a plain
 * on/off: 0 locks the page, N caps how many departments can exist, and the same
 * number is enforced server-side on every write. The page stays reachable when
 * the plan excludes it — the same call the plan cards make, where excluded
 * features are struck through rather than hidden — but it says so and offers the
 * upgrade instead of rendering a card that 403s on first touch.
 */
export default function HumanTransferPage() {
  const navigate = useNavigate();

  // Seed from the cached entitlement so a revisit doesn't flash locked, then
  // confirm with the backend. Infinity until we know, so the first paint never
  // shows a false "not in your plan".
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
