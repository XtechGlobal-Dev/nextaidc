import { useEffect, useState } from "react";
import { Loader2, Receipt } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { api, type BrandLedger } from "@/lib/api";
import { formatMoney } from "@/lib/currency";
import { formatDateDMY } from "@/lib/utils";

/**
 * What this brand's customers paid, and how each payment split between the
 * platform and the brand — read from the platform ledger, the one place the
 * split is written down. The wallet above is credited from these rows.
 */
export function BrandLedgerCard({ brandId }: { brandId: string }) {
  const [ledger, setLedger] = useState<BrandLedger | null>(null);

  useEffect(() => {
    let active = true;
    api.super.brands
      .ledger(brandId)
      .then((l) => {
        if (active) setLedger(l);
      })
      .catch(() => {
        if (active) setLedger({ from: "", to: "", totals: [], rows: [] });
      });
    return () => {
      active = false;
    };
  }, [brandId]);

  return (
    <Card className="p-5">
      <div>
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <Receipt className="size-4 text-primary" /> Payments
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Every paid customer invoice, split into the platform's share (the plan's base price)
          and this brand's share (its addon). The wallet is credited from these rows.
        </p>
      </div>

      {ledger === null ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      ) : ledger.rows.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">No payments recorded yet.</p>
      ) : (
        <>
          {ledger.totals.length > 0 && (
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {ledger.totals.map((t) => (
                <div key={t.currency} className="rounded-lg border border-border p-3">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">
                    This month · {t.currency.toUpperCase()}
                  </div>
                  <div className="mt-1 text-2xl font-semibold tabular-nums">
                    {formatMoney(t.totalCents, t.currency)}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {formatMoney(t.platformCents, t.currency)} platform ·{" "}
                    {formatMoney(t.brandCents, t.currency)} brand · {t.payments} payment
                    {t.payments === 1 ? "" : "s"}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3 font-medium">Paid</th>
                  <th className="py-2 pr-3 font-medium">Customer</th>
                  <th className="py-2 pr-3 font-medium">Plan</th>
                  <th className="py-2 pr-3 text-right font-medium">Total</th>
                  <th className="py-2 pr-3 text-right font-medium">Platform</th>
                  <th className="py-2 pr-3 text-right font-medium">Brand</th>
                  <th className="py-2 font-medium">Via</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {ledger.rows.map((r) => (
                  <tr key={r.id} className="tabular-nums">
                    <td className="py-2 pr-3 whitespace-nowrap">{formatDateDMY(r.paidAt)}</td>
                    <td className="py-2 pr-3">{r.customerEmail ?? r.userId}</td>
                    <td className="py-2 pr-3">{r.planName ?? "—"}</td>
                    <td className="py-2 pr-3 text-right">
                      {formatMoney(r.totalCents, r.currency)}
                      {r.refundedCents > 0 && (
                        <Badge variant="outline" className="ml-2">
                          {formatMoney(r.refundedCents, r.currency)} refunded
                        </Badge>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right">{formatMoney(r.platformCents, r.currency)}</td>
                    <td className="py-2 pr-3 text-right">{formatMoney(r.brandCents, r.currency)}</td>
                    <td className="py-2 text-muted-foreground">{r.source.replace("_", " ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
