import { ExternalLink } from "lucide-react";
import type { BrandInvoice } from "@/lib/api";
import { formatMoney } from "@/lib/currency";

// A brand's invoices from the platform, as Stripe issued them — shown to the brand's admin on its
// Billing page and to the super admin on the brand's Billing tab.

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

export function BrandInvoiceTable({ invoices }: { invoices: BrandInvoice[] }) {
  if (invoices.length === 0) {
    return <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">No invoices yet.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2 font-medium">Date</th>
            <th className="px-3 py-2 font-medium">Number</th>
            <th className="px-3 py-2 font-medium">Amount</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2">
              <span className="sr-only">Link</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((inv) => (
            <tr key={inv.id} className="border-b border-border/60 last:border-0">
              <td className="whitespace-nowrap px-3 py-2">{fmtDate(inv.created)}</td>
              <td className="px-3 py-2 font-mono text-xs">{inv.number || "—"}</td>
              <td className="px-3 py-2 tabular-nums">{formatMoney(inv.amountCents, inv.currency)}</td>
              <td className="px-3 py-2 capitalize">{inv.status}</td>
              <td className="px-3 py-2 text-right">
                {inv.url && (
                  <a
                    href={inv.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    View <ExternalLink className="size-3" />
                  </a>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
