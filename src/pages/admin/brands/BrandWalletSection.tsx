import { useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Download, Loader2, Wallet } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ApiError, type BrandWallet, type WalletEntry } from "@/lib/api";
import { formatMoney } from "@/lib/currency";
import { formatDateDMY } from "@/lib/utils";
import { datedCsvName, downloadCsv, toCsv } from "@/lib/csv";

/** The statement a brand reconciles against its bank: one row per entry. */
function exportStatement(entries: WalletEntry[]): void {
  downloadCsv(
    datedCsvName("wallet-statement"),
    toCsv(
      [
        { header: "Date", value: (e) => e.createdAt.slice(0, 10) },
        { header: "Type", value: (e) => e.type },
        { header: "Amount", value: (e) => (e.amountCents / 100).toFixed(2) },
        { header: "Currency", value: (e) => e.currency.toUpperCase() },
        { header: "Plan", value: (e) => e.planName ?? "" },
        { header: "Customer", value: (e) => e.customerEmail ?? "" },
        { header: "Invoice", value: (e) => e.stripeInvoiceId ?? e.relatedInvoiceId ?? "" },
        { header: "Reference", value: (e) => e.reference },
        { header: "Note", value: (e) => e.note },
      ],
      entries,
    ),
  );
}

// Brand wallet: owed, history, payouts. Platform owner records payouts; brand admin is read-only.

export function BrandWalletSection({
  wallet,
  onPayout,
}: {
  wallet: BrandWallet | null;
  /** Present for the platform owner: records a payout made by hand. */
  onPayout?: (data: {
    amountCents: number;
    currency: string;
    reference: string;
    note: string;
  }) => Promise<void>;
}) {
  return (
    <div className="space-y-5">
      <Card className="space-y-4 p-5">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Wallet className="size-4 text-primary" /> Wallet
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Every paid customer invoice credits the brand's addon share here. Payouts are made by
            the platform outside the app and recorded against the balance.
          </p>
        </div>

        {wallet === null ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </p>
        ) : wallet.balances.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing credited yet.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            {wallet.balances.map((b) => (
              <div key={b.currency} className="rounded-lg border border-border p-3">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Balance · {b.currency.toUpperCase()}
                </div>
                <div className="mt-1 text-2xl font-semibold tabular-nums">
                  {formatMoney(b.balanceCents, b.currency)}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {formatMoney(b.creditedCents, b.currency)} credited ·{" "}
                  {formatMoney(b.paidOutCents, b.currency)} paid out
                </div>
              </div>
            ))}
          </div>
        )}

        {onPayout && wallet && wallet.balances.length > 0 && (
          <PayoutForm wallet={wallet} onPayout={onPayout} />
        )}
      </Card>

      <Card className="p-5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">History</h3>
          {wallet && wallet.entries.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => exportStatement(wallet.entries)}>
              <Download className="size-4" /> Export CSV
            </Button>
          )}
        </div>
        {wallet === null ? null : wallet.entries.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No entries yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">When</th>
                  <th className="py-2 pr-4 font-medium">Entry</th>
                  <th className="py-2 pr-4 font-medium">Details</th>
                  <th className="py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {wallet.entries.map((e) => (
                  <EntryRow key={e.id} entry={e} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function EntryRow({ entry }: { entry: WalletEntry }) {
  const positive = entry.amountCents > 0;
  return (
    <tr className="border-b border-border/60 last:border-0">
      <td className="whitespace-nowrap py-2.5 pr-4 text-muted-foreground">
        {formatDateDMY(entry.createdAt)}
      </td>
      <td className="py-2.5 pr-4">
        {entry.type === "credit" ? (
          <Badge variant="success">
            <ArrowDownLeft className="mr-1 size-3" /> Credit
          </Badge>
        ) : entry.type === "payout" ? (
          <Badge variant="neutral">
            <ArrowUpRight className="mr-1 size-3" /> Payout
          </Badge>
        ) : (
          <Badge variant="warning">Reversal</Badge>
        )}
      </td>
      <td className="py-2.5 pr-4 text-muted-foreground">
        {entry.type === "credit" ? (
          <>
            {entry.planName ?? "Plan"}
            {entry.customerEmail ? ` · ${entry.customerEmail}` : ""}
            {entry.stripeInvoiceId ? (
              <span className="ml-1 font-mono text-[11px]">{entry.stripeInvoiceId}</span>
            ) : null}
          </>
        ) : (
          <>
            {entry.reference ? <span className="font-mono text-xs">{entry.reference}</span> : "—"}
            {entry.note ? ` · ${entry.note}` : ""}
          </>
        )}
      </td>
      <td
        className={`py-2.5 text-right font-medium tabular-nums ${positive ? "text-success" : ""}`}
      >
        {positive ? "+" : ""}
        {formatMoney(entry.amountCents, entry.currency)}
      </td>
    </tr>
  );
}

function PayoutForm({
  wallet,
  onPayout,
}: {
  wallet: BrandWallet;
  onPayout: NonNullable<Parameters<typeof BrandWalletSection>[0]["onPayout"]>;
}) {
  const [currency, setCurrency] = useState(wallet.balances[0]?.currency ?? "usd");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const available = wallet.balances.find((b) => b.currency === currency)?.balanceCents ?? 0;
  const cents = Math.round((Number.parseFloat(amount || "0") || 0) * 100);
  const valid = cents > 0 && cents <= available;

  async function submit() {
    setSaving(true);
    try {
      await onPayout({ amountCents: cents, currency, reference, note });
      toast.success(`Payout of ${formatMoney(cents, currency)} recorded.`);
      setAmount("");
      setReference("");
      setNote("");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't record the payout.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
      <div>
        <h4 className="text-sm font-semibold">Record a payout</h4>
        <p className="text-xs text-muted-foreground">
          After paying the brand by bank transfer, log it here so the balance and the brand's
          history stay right. Up to {formatMoney(available, currency)} available.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <div>
          <Label htmlFor="po-currency">Currency</Label>
          <Select value={currency} onValueChange={setCurrency}>
            <SelectTrigger id="po-currency" className="mt-1.5">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {wallet.balances.map((b) => (
                <SelectItem key={b.currency} value={b.currency}>
                  {b.currency.toUpperCase()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="po-amount">Amount</Label>
          <Input
            id="po-amount"
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            className="mt-1.5 tabular-nums"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={(available / 100).toFixed(2)}
          />
        </div>
        <div>
          <Label htmlFor="po-ref">Reference</Label>
          <Input
            id="po-ref"
            className="mt-1.5"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Bank ref / transfer id"
          />
        </div>
        <div>
          <Label htmlFor="po-note">Note</Label>
          <Input
            id="po-note"
            className="mt-1.5"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional"
          />
        </div>
      </div>
      <div className="flex justify-end">
        <Button onClick={() => void submit()} disabled={!valid || saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Wallet className="size-4" />}
          Record payout
        </Button>
      </div>
    </div>
  );
}
