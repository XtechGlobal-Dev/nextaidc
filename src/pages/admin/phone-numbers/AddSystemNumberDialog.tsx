import { useEffect, useState } from "react";
import { Loader2, Phone, RefreshCw, Search, ShoppingCart } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { cn } from "@/lib/utils";
import { api, ApiError } from "@/lib/api";
import { COUNTRIES, NUMBER_PREFIXES, formatNumberPrice, type NumberPricing } from "@/data/countries";
import type { ImportableNumber } from "./types";

type Mode = "import" | "purchase";

interface Props {
  open: boolean;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}

function errMsg(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : fallback;
}

export function AddSystemNumberDialog({ open, onClose, onChanged }: Props) {
  const [mode, setMode] = useState<Mode>("import");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Import tab
  const [available, setAvailable] = useState<ImportableNumber[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // Purchase tab
  const [country, setCountry] = useState("us");
  const [prefix, setPrefix] = useState("");
  const [areaCode, setAreaCode] = useState("");
  const [searchResults, setSearchResults] = useState<ImportableNumber[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);

  const countryPrefixes = NUMBER_PREFIXES[country] ?? [];
  const [pricing, setPricing] = useState<NumberPricing | null>(null);

  // Load live Twilio pricing for the selected country.
  useEffect(() => {
    if (mode !== "purchase" || !country) return;
    let active = true;
    setPricing(null);
    api.profile
      .numberPricing(country.toUpperCase())
      .then((p) => active && setPricing(p))
      .catch(() => active && setPricing(null));
    return () => {
      active = false;
    };
  }, [mode, country]);

  function close() {
    setMode("import");
    setAvailable(null);
    setPicked(new Set());
    setCountry("us");
    setPrefix("");
    setAreaCode("");
    setSearchResults(null);
    setChosen(null);
    onClose();
  }

  async function loadFromTwilio() {
    setLoading(true);
    setAvailable(null);
    setPicked(new Set());
    try {
      const list = await api.admin.phoneNumbers.twilioAvailable();
      setAvailable(list);
      if (list.length === 0) {
        toast.info("No new numbers — all your Twilio numbers are already in the pool.");
      }
    } catch (e) {
      toast.error(errMsg(e, "Couldn't load Twilio numbers"));
    } finally {
      setLoading(false);
    }
  }

  async function searchTwilio(prefixOverride?: string) {
    setLoading(true);
    setSearchResults(null);
    setChosen(null);
    try {
      const iso = country.toUpperCase();
      const pfx = prefixOverride !== undefined ? prefixOverride : prefix;
      const params: { country: string; prefix?: string; areaCode?: string } = { country: iso };
      if (countryPrefixes.length && pfx) params.prefix = pfx;
      else if (areaCode.trim()) params.areaCode = areaCode.trim();
      const list = await api.admin.phoneNumbers.twilioSearch(params);
      setSearchResults(list);
      if (list.length === 0) toast.info("No purchasable numbers matched that search.");
    } catch (e) {
      toast.error(errMsg(e, "Twilio search failed"));
    } finally {
      setLoading(false);
    }
  }

  function handlePrefixChange(value: string) {
    setPrefix(value);
    void searchTwilio();
  }

  function togglePick(sid: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(sid)) next.delete(sid);
      else next.add(sid);
      return next;
    });
  }

  const allImportSelected =
    !!available && available.length > 0 && available.every((n) => picked.has(n.sid));

  function toggleSelectAll() {
    if (!available) return;
    setPicked(allImportSelected ? new Set() : new Set(available.map((n) => n.sid)));
  }

  async function importPicked() {
    const items = (available ?? []).filter((n) => picked.has(n.sid));
    if (!items.length) return;
    setSubmitting(true);
    try {
      for (const n of items) {
        await api.admin.phoneNumbers.addSystem({ number: n.number, sid: n.sid, purchase: false });
      }
      toast.success(`Imported ${items.length} number${items.length > 1 ? "s" : ""} to the system pool`);
      await onChanged();
      close();
    } catch (e) {
      toast.error(errMsg(e, "Import failed"));
    } finally {
      setSubmitting(false);
    }
  }

  async function purchaseChosen() {
    if (!chosen) return;
    setSubmitting(true);
    try {
      await api.admin.phoneNumbers.addSystem({ number: chosen, purchase: true });
      toast.success(`Purchased ${chosen} and added it to the system pool`);
      await onChanged();
      close();
    } catch (e) {
      toast.error(errMsg(e, "Purchase failed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add System Phone Number</DialogTitle>
          <DialogDescription>
            Import existing numbers from Twilio or purchase new ones for the system pool.
          </DialogDescription>
        </DialogHeader>

        {/* Mode switch */}
        <div className="grid grid-cols-2 gap-2 rounded-lg border border-border p-1">
          <ModeTab active={mode === "import"} onClick={() => setMode("import")}>
            Import Existing
          </ModeTab>
          <ModeTab active={mode === "purchase"} onClick={() => setMode("purchase")}>
            Purchase New
          </ModeTab>
        </div>

        {mode === "import" ? (
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h4 className="text-sm font-semibold">Active Twilio Numbers</h4>
                <p className="text-xs text-muted-foreground">
                  Load numbers from your Twilio account that aren’t already in the system pool.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={loadFromTwilio} disabled={loading}>
                {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                Load from Twilio
              </Button>
            </div>

            <div className="min-h-56 rounded-lg border border-border">
              {loading ? (
                <div className="flex h-56 flex-col items-center justify-center gap-2 text-muted-foreground">
                  <Loader2 className="size-5 animate-spin" />
                  <p className="text-sm">Fetching available numbers…</p>
                </div>
              ) : !available ? (
                <div className="flex h-56 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
                  <Phone className="size-7" />
                  <p className="text-sm">Click “Load from Twilio” to fetch available numbers</p>
                </div>
              ) : available.length === 0 ? (
                <div className="flex h-56 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
                  <Phone className="size-7" />
                  <p className="text-sm">No new numbers found in your Twilio account.</p>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  <label className="flex cursor-pointer items-center gap-3 bg-muted/30 px-3 py-2.5 hover:bg-muted/50">
                    <input
                      type="checkbox"
                      checked={allImportSelected}
                      onChange={toggleSelectAll}
                      className="size-4 accent-[var(--color-primary)]"
                    />
                    <span className="flex-1 text-sm font-semibold">Select all</span>
                    <span className="text-xs text-muted-foreground">
                      {picked.size}/{available.length}
                    </span>
                  </label>
                  <ul className="divide-y divide-border">
                    {available.map((n) => (
                      <li key={n.sid}>
                        <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-muted/40">
                          <input
                            type="checkbox"
                            checked={picked.has(n.sid)}
                            onChange={() => togglePick(n.sid)}
                            className="size-4 accent-[var(--color-primary)]"
                          />
                          <span className="flex-1 text-sm font-medium tabular-nums">{n.number}</span>
                          <span className="text-xs text-muted-foreground">
                            ${(n.monthlyPriceCents / 100).toFixed(2)}/mo
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Country</Label>
              <Select
                value={country}
                onValueChange={(v) => {
                  setCountry(v);
                  setPrefix("");
                  setAreaCode("");
                  setSearchResults(null);
                  setChosen(null);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COUNTRIES.map((c) => (
                    <SelectItem key={c.code} value={c.code}>
                      {c.name} +{c.dial}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {countryPrefixes.length > 0 ? (
              <div className="space-y-1.5">
                <Label>Number prefix</Label>
                <Select value={prefix} onValueChange={handlePrefixChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="Pick a prefix (e.g. 03, 04) to see numbers" />
                  </SelectTrigger>
                  <SelectContent>
                    {countryPrefixes.map((p) => {
                      const price = pricing?.prices[p.type];
                      return (
                      <SelectItem key={p.value} value={p.value}>
                        {p.label}
                        {price !== undefined && ` — ${formatNumberPrice(pricing!.currency, price)}`}
                      </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="area-code">Area code (optional)</Label>
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="area-code"
                      placeholder="e.g. 415"
                      value={areaCode}
                      onChange={(e) => setAreaCode(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && searchTwilio()}
                      className="pl-9"
                    />
                  </div>
                  <Button variant="outline" onClick={() => searchTwilio()} disabled={loading}>
                    {loading ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
                    Search
                  </Button>
                </div>
              </div>
            )}
            <div className="min-h-56 rounded-lg border border-border">
              {loading ? (
                <div className="flex h-56 flex-col items-center justify-center gap-2 text-muted-foreground">
                  <Loader2 className="size-5 animate-spin" />
                  <p className="text-sm">Searching Twilio…</p>
                </div>
              ) : !searchResults ? (
                <div className="flex h-56 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
                  <ShoppingCart className="size-7" />
                  <p className="text-sm">Search to see numbers available to purchase.</p>
                </div>
              ) : searchResults.length === 0 ? (
                <div className="flex h-56 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
                  <ShoppingCart className="size-7" />
                  <p className="text-sm">No purchasable numbers matched.</p>
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {searchResults.map((n) => (
                    <li key={n.sid}>
                      <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-muted/40">
                        <input
                          type="radio"
                          name="purchase-number"
                          checked={chosen === n.number}
                          onChange={() => setChosen(n.number)}
                          className="size-4 accent-[var(--color-primary)]"
                        />
                        <span className="flex-1 text-sm font-medium tabular-nums">{n.number}</span>
                        <span className="text-xs text-muted-foreground">
                          ${(n.monthlyPriceCents / 100).toFixed(2)}/mo
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={submitting}>
            Cancel
          </Button>
          {mode === "import" ? (
            <Button onClick={importPicked} disabled={picked.size === 0 || submitting}>
              {submitting && <Loader2 className="size-4 animate-spin" />}
              Import to System Pool{picked.size > 0 ? ` (${picked.size})` : ""}
            </Button>
          ) : (
            <Button onClick={purchaseChosen} disabled={!chosen || submitting}>
              {submitting && <Loader2 className="size-4 animate-spin" />}
              Purchase Number
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ModeTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md px-3 py-2 text-sm font-semibold transition-colors",
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}
