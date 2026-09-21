import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowRight,
  BrainCircuit,
  Check,
  Loader2,
  Lock,
  Phone,
  RefreshCw,
  SlidersHorizontal,
  Search,
  User,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { api, type NumberMatch, type SubscriptionDetail } from "@/lib/api";
import { formatMoney, couponDiscountCents } from "@/lib/currency";
import { clearCachedEntitlements } from "@/lib/planFeatures";
import { useProfileStore } from "@/stores/useProfileStore";
import { useTrialStore } from "@/stores/useTrialStore";
import { useQuickSetupStore } from "@/stores/useQuickSetupStore";
import {
  COUNTRIES,
  NUMBER_PREFIXES,
  guessCountry,
  type Country,
} from "@/data/countries";
import { toast } from "sonner";

/** Fallback when the admin's allowed-country list can't be loaded. AU first so it
 *  wins as the default when we can't detect the visitor's country (our main market). */
const FALLBACK_COUNTRIES = ["au", "us"]
  .map((code) => COUNTRIES.find((c) => c.code === code))
  .filter((c): c is Country => Boolean(c));

/** Pick the country to pre-select: the visitor's detected country when the admin
 *  offers it, otherwise Australia (our primary market), otherwise the first offered. */
function pickDefaultCountry(allowed: Country[]): string {
  const has = (code: string) => allowed.some((c) => c.code === code);
  const detected = guessCountry().code;
  if (has(detected)) return detected;
  if (has("au")) return "au";
  return allowed[0]?.code ?? "au";
}

type PoolNumber = { number: string; taken: boolean; mine: boolean };

/** Stands in for "no prefix" in the Select — Radix rejects "" as an item value. */
const PREFIX_ANY = "any";

/** How many search hits to show. Twilio will return up to 20, but that many rows
 *  turns this modal into a long scroll — and nobody compares the 18th option. */
const SEARCH_RESULT_LIMIT = 10;

/** Mask a taken number — keep only the last 4 digits, hide the rest. */
function maskNumber(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length <= 4) return raw;
  return `${"•".repeat(digits.length - 4)}${digits.slice(-4)}`;
}

export default function Step3Number() {
  const selectedNumber = useQuickSetupStore((s) => s.selectedNumber);
  const selectNumber = useQuickSetupStore((s) => s.selectNumber);
  const next = useQuickSetupStore((s) => s.next);

  // Countries the admin allows + the one currently picked (ISO code, lowercase).
  const [countries, setCountries] = useState<Country[]>(FALLBACK_COUNTRIES);
  const [countryCode, setCountryCode] = useState<string>(() =>
    pickDefaultCountry(FALLBACK_COUNTRIES),
  );
  // Once the user picks a country themselves, stop auto-selecting from detection.
  const userPickedCountry = useRef(false);
  // Per-country prefixes the admin allows (iso → prefix[]); absent = all allowed.
  const [allowedPrefixes, setAllowedPrefixes] = useState<Record<string, string[]>>({});
  const [pool, setPool] = useState<PoolNumber[] | null>(null);
  const [configured, setConfigured] = useState(true);
  const [saving, setSaving] = useState(false);
  // Admin-gated "buy a brand-new number" flow.
  const [canBuyMore, setCanBuyMore] = useState(false);
  const [extra, setExtra] = useState<string[] | null>(null);
  const [extraSelected, setExtraSelected] = useState<string | null>(null);
  const [prefix, setPrefix] = useState<string>("");
  // Digit search, kept separate from `prefix` so the two filters don't silently fight.
  const [digits, setDigits] = useState("");
  const [match, setMatch] = useState<NumberMatch>("anywhere");
  // Anything narrowing the list right now — drives whether "Reset" is offered.
  const filtersActive = Boolean(digits) || Boolean(prefix) || match !== "anywhere";
  const [searching, setSearching] = useState(false);
  const [buying, setBuying] = useState(false);
  // Going live ends the trial and charges the saved card — confirm before doing it.
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Plan name + price for the confirm dialog; only fetched while still trialing.
  const trial = useTrialStore((s) => s.trial);
  const onTrial = trial?.phase === "trial";
  const [sub, setSub] = useState<SubscriptionDetail | null>(null);
  useEffect(() => {
    if (!onTrial) return;
    let active = true;
    api.billing
      .subscription()
      .then((r) => {
        if (active) setSub(r.subscription);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [onTrial]);

  // Load the real number pool from the connected Twilio account.
  useEffect(() => {
    let active = true;
    api.profile
      .availableNumbers()
      .then((r) => {
        if (!active) return;
        setConfigured(r.configured);
        setPool(r.numbers);
        setCanBuyMore(r.canBuyMore);
      })
      .catch(() => {
        if (!active) return;
        setConfigured(false);
        setPool([]);
      });
    return () => {
      active = false;
    };
  }, []);

  // Load the admin-allowed countries for the selection dropdown.
  useEffect(() => {
    let active = true;
    api.profile
      .numberCountries()
      .then((r) => {
        if (!active) return;
        const allowed = new Set(r.countries.map((c) => c.toLowerCase()));
        const list = COUNTRIES.filter((c) => allowed.has(c.code));
        const final = list.length ? list : FALLBACK_COUNTRIES;
        setCountries(final);
        setAllowedPrefixes(r.prefixes ?? {});
        // Re-pick from the real allowed list (detected country → AU → first),
        // unless the user has already chosen a country manually.
        setCountryCode((prev) =>
          userPickedCountry.current && final.some((c) => c.code === prev)
            ? prev
            : pickDefaultCountry(final),
        );
      })
      .catch(() => {
        if (!active) return;
        setCountries(FALLBACK_COUNTRIES);
      });
    return () => {
      active = false;
    };
  }, []);

  // Fetched numbers are country-specific — reset them when the country changes.
  useEffect(() => {
    setExtra(null);
    setExtraSelected(null);
    setPrefix("");
  }, [countryCode]);

  // Prefix options for the chosen country, filtered to those the admin allows
  // (an absent entry means all prefixes are allowed).
  const allowedForCountry = allowedPrefixes[countryCode];
  const countryPrefixes = (NUMBER_PREFIXES[countryCode] ?? []).filter(
    (p) => allowedForCountry === undefined || allowedForCountry.includes(p.value),
  );

  async function runSearch(prefixVal?: string, opts?: { q?: string; match?: NumberMatch }) {
    if (searching) return;
    setSearching(true);
    try {
      const q = opts?.q?.replace(/\D/g, "") || undefined;
      const r = await api.profile.searchableNumbers((countryCode || "us").toUpperCase(), {
        // Both filters go up together — digits pick the numbers, the prefix picks
        // the series. Either alone works too.
        prefix: prefixVal || undefined,
        q,
        match: opts?.match,
        // A narrowed search deserves more than the default handful of results.
        // Ten is about what fits without turning the modal into a scroller.
        limit: q ? SEARCH_RESULT_LIMIT : prefixVal ? 5 : undefined,
      });
      setExtra(r.numbers);
      setExtraSelected(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't fetch new numbers");
    } finally {
      setSearching(false);
    }
  }

  function handleSeeMore() {
    void runSearch(prefix || undefined, digits ? { q: digits, match } : undefined);
  }

  function handlePrefixChange(value: string) {
    // "Any prefix" is modelled as an empty prefix — Radix Select can't hold "" as
    // an item value, so it round-trips through a sentinel.
    const next = value === PREFIX_ANY ? "" : value;
    setPrefix(next);
    void runSearch(next || undefined, digits ? { q: digits, match } : undefined);
  }

  function handleDigitSearch() {
    if (!digits.replace(/\D/g, "")) return;
    void runSearch(prefix || undefined, { q: digits, match });
  }

  function handleResetFilters() {
    setDigits("");
    setPrefix("");
    setMatch("anywhere");
    void runSearch();
  }

  // Auto-load a default set (min 5) once the buy section is available and no prefix
  // is chosen yet — so the user sees numbers without having to click "See more".
  useEffect(() => {
    if (canBuyMore && countryCode && !prefix && !digits && extra === null && !searching) {
      void runSearch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canBuyMore, countryCode, prefix, digits, extra]);

  async function handleBuy() {
    if (!extraSelected || buying) return;
    setBuying(true);
    try {
      await api.profile.buyNumber(extraSelected, countryCode.toUpperCase());
      selectNumber(extraSelected);
      void useProfileStore.getState().hydrate();
      void useTrialStore.getState().hydrate(); // the plan may have just activated
      clearCachedEntitlements(); // …and with it, which features are included
      next();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't buy that number");
    } finally {
      setBuying(false);
    }
  }

  // Numbers matching the chosen country's calling code.
  const selectedCountry = useMemo(
    () => countries.find((c) => c.code === countryCode) ?? null,
    [countries, countryCode],
  );
  const code = selectedCountry ? `+${selectedCountry.dial}` : "";
  const matching = useMemo(
    () => (pool ?? []).filter((n) => (code ? n.number.replace(/\s/g, "").startsWith(code) : true)),
    [pool, code],
  );
  const available = matching.filter((n) => !n.taken);

  // Auto-select the first free number, but never while a brand-new pick is active or it re-arms the pool selection.
  useEffect(() => {
    if (available.length === 0 || extraSelected) return;
    const stillValid = selectedNumber && available.some((n) => n.number === selectedNumber);
    if (!stillValid) selectNumber(available[0].number);
  }, [available, selectedNumber, selectNumber, extraSelected]);

  const poolSelected = available.some((n) => n.number === selectedNumber);

  // Both lists are one choice: picking in either clears the other, or Save quietly claimed the pool number.
  function pickPoolNumber(number: string) {
    setExtraSelected(null);
    selectNumber(number);
  }

  function pickExtraNumber(number: string | null) {
    setExtraSelected(number);
    if (number) selectNumber("");
  }

  // Continue once EITHER list has a pick; nothing selected → the button stays off.
  const canContinue = poolSelected || !!extraSelected;

  // Claim (or buy) then advance. Assigning ends the trial and charges server-side; a failed charge errors here and we stay put.
  async function proceed() {
    if (extraSelected) {
      await handleBuy();
      return;
    }
    if (!selectedNumber) return;
    setSaving(true);
    try {
      await api.profile.claimNumber(selectedNumber, countryCode.toUpperCase());
      void useProfileStore.getState().hydrate();
      void useTrialStore.getState().hydrate(); // the plan may have just activated
      next();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't reserve that number");
    } finally {
      setSaving(false);
    }
  }

  // Re-check the pick here (disabled is strippable in devtools). Trial users confirm first since going live charges now.
  function handleContinue() {
    if (saving || buying) return;
    if (!canContinue) {
      toast.error("Pick a number first.");
      return;
    }
    if (onTrial) {
      setConfirmOpen(true);
      return;
    }
    void proceed();
  }

  async function confirmAndProceed() {
    setConfirmOpen(false);
    await proceed();
  }

  return (
    <div className="space-y-6">
      <h2 className="text-center text-2xl font-bold">Pick your dedicated AI number</h2>

      <div className="space-y-3 rounded-xl bg-primary-tint-soft p-4">
        <div className="flex items-start gap-2.5 text-sm">
          <Check className="mt-0.5 size-4 shrink-0 text-primary" />
          <p>
            <span className="font-semibold">AI Number:</span> Where your AI
            assistant lives to catch your forwarded calls.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Select your country
        </label>
        <Select
          value={countryCode}
          onValueChange={(v) => {
            userPickedCountry.current = true;
            setCountryCode(v);
          }}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select country" />
          </SelectTrigger>
          {/* QuickSetupModal sits at z-[1001]; the dropdown portals to <body> at the
              default z-[60], which lands it BEHIND the modal — lift it above. */}
          <SelectContent className="z-[1100]">
            {countries.map((c) => (
              <SelectItem key={c.code} value={c.code}>
                {c.name} +{c.dial}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-xl border border-border">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Available mobile numbers
          </span>
          <span className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Lock className="size-3" />
            Reserved
          </span>
        </div>

        <div className="divide-y divide-border">
          {pool === null ? (
            <div className="flex items-center justify-center gap-2 px-4 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Finding available numbers…
            </div>
          ) : !configured || matching.length === 0 ? (
            <div className="px-4 py-5 text-center text-sm text-muted-foreground">
              No numbers in the pool yet — we&apos;ll assign your dedicated AI number when you go
              live.
            </div>
          ) : (
            matching.map((n) => {
              const selected = !n.taken && n.number === selectedNumber;
              return (
                <button
                  key={n.number}
                  type="button"
                  disabled={n.taken}
                  onClick={() => pickPoolNumber(n.number)}
                  className={cn(
                    "flex w-full items-center justify-between px-4 py-3 text-left transition-colors",
                    selected ? "bg-success-tint" : !n.taken && "hover:bg-muted",
                  )}
                >
                  <span
                    className={cn(
                      "font-mono text-sm",
                      n.taken ? "text-muted-foreground" : "font-medium",
                    )}
                  >
                    {n.taken ? maskNumber(n.number) : n.number}
                  </span>
                  {n.taken ? (
                    <Badge variant="danger">✕ Taken</Badge>
                  ) : selected ? (
                    <Badge variant="success">
                      <Check className="size-3" />
                      Reserved &amp; selected
                    </Badge>
                  ) : (
                    <span className="text-xs font-medium text-primary">Select</span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>

      {canBuyMore && (
        <div className="space-y-3">
          {/* One panel for both filters; as loose fields they read as unrelated and the reset link wrapped. */}
          <div className="rounded-xl border border-border bg-muted/40">
            <div className="flex items-center justify-between gap-2 border-b border-border px-3.5 py-2">
              <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <SlidersHorizontal className="size-3.5" />
                Find a number
              </span>
              {filtersActive && (
                <button
                  type="button"
                  onClick={handleResetFilters}
                  disabled={searching}
                  className="text-xs font-medium text-primary transition-opacity hover:opacity-80 disabled:opacity-60"
                >
                  Reset
                </button>
              )}
            </div>

            <div className="space-y-2.5 p-3.5">
              {/* Digits + position, modelled on Twilio's picker; the button wraps below on narrow screens. */}
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={digits}
                  onChange={(e) => setDigits(e.target.value.replace(/\D/g, "").slice(0, 10))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleDigitSearch();
                    }
                  }}
                  placeholder="Digits, e.g. 1111"
                  inputMode="numeric"
                  className="h-9 min-w-[7.5rem] flex-1 bg-background"
                  aria-label="Digits to search for"
                />
                <Select value={match} onValueChange={(v) => setMatch(v as NumberMatch)}>
                  <SelectTrigger className="h-9 w-[168px] bg-background">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="z-[1100]">
                    <SelectItem value="start">First part</SelectItem>
                    <SelectItem value="anywhere">Anywhere</SelectItem>
                    <SelectItem value="end">Last part</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  size="sm"
                  className="h-9"
                  onClick={handleDigitSearch}
                  disabled={searching || !digits}
                >
                  {searching ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Search className="size-4" />
                  )}
                  Search
                </Button>
              </div>

              {countryPrefixes.length > 0 && (
                <Select value={prefix || PREFIX_ANY} onValueChange={handlePrefixChange}>
                  <SelectTrigger className="h-9 bg-background">
                    <SelectValue placeholder="Any prefix" />
                  </SelectTrigger>
                  <SelectContent className="z-[1100]">
                    <SelectItem value={PREFIX_ANY}>Any prefix</SelectItem>
                    {countryPrefixes.map((p) => (
                      <SelectItem key={p.value} value={p.value}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>

          {extra === null ? (
            <button
              type="button"
              onClick={handleSeeMore}
              disabled={searching}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border py-3 text-sm font-medium text-primary transition-colors hover:bg-muted disabled:opacity-60"
            >
              {searching ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              {prefix ? "Search numbers" : "See more numbers"}
            </button>
          ) : (
            <div className="rounded-xl border border-border">
              <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                <span className="flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Buy a brand-new number
                  {/* A count only means something once the list has been narrowed —
                      on the unfiltered default set it would read as "all we have". */}
                  {filtersActive && extra.length > 0 && (
                    <span className="font-medium normal-case tracking-normal text-foreground/70">
                      {extra.length} match{extra.length === 1 ? "" : "es"}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={handleSeeMore}
                  disabled={searching}
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary disabled:opacity-60"
                  aria-label="Refresh numbers"
                >
                  <RefreshCw className={cn("size-3.5", searching && "animate-spin")} />
                  Refresh
                </button>
              </div>
              <div className="divide-y divide-border">
                {extra.length === 0 ? (
                  <p className="px-4 py-5 text-center text-sm text-muted-foreground">
                    {digits
                      ? "No numbers match those digits — try fewer digits, or \"Anywhere in number\"."
                      : "No new numbers found — try a different country."}
                  </p>
                ) : (
                  /* Same row treatment as the pool list; the purchase happens on Buy and continue, no separate confirm. */
                  extra.map((number) => {
                    const sel = extraSelected === number;
                    return (
                      <button
                        key={number}
                        type="button"
                        onClick={() => pickExtraNumber(sel ? null : number)}
                        className={cn(
                          "flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors",
                          sel ? "bg-success-tint" : "hover:bg-muted",
                        )}
                      >
                        <span className="font-mono text-sm font-medium">{number}</span>
                        {sel ? (
                          <Badge variant="success">
                            <Check className="size-3" />
                            Selected
                          </Badge>
                        ) : (
                          <span className="text-xs font-medium text-primary">Select</span>
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="space-y-4">
        <h3 className="text-center text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          How call forwarding works
        </h3>
        <div className="flex items-center justify-center">
          <FlowNode icon={<User className="size-5" />} label="Customer" />
          <Connector />
          <FlowNode icon={<Phone className="size-5" />} label="Your Phone" />
          <Connector />
          <FlowNode icon={<BrainCircuit className="size-5" />} label="Your AI" />
        </div>
      </div>

      <Button
        size="lg"
        className="w-full"
        onClick={handleContinue}
        disabled={saving || buying || !canContinue}
      >
        {saving || buying ? <Loader2 className="animate-spin" /> : null}
        {extraSelected ? "BUY AND CONTINUE" : "SAVE AND CONTINUE"}
        {!saving && !buying && <ArrowRight />}
      </Button>
      {!canContinue && (
        <p className="text-center text-xs text-muted-foreground">
          Select a number above to continue.
        </p>
      )}

      <GoLiveConfirm
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        sub={sub}
        busy={saving || buying}
        onConfirm={confirmAndProceed}
      />
    </div>
  );
}

/** Confirm before a trial user goes live: assigning a number ends the trial and charges the saved card. */
function GoLiveConfirm({
  open,
  onOpenChange,
  sub,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sub: SubscriptionDetail | null;
  busy: boolean;
  onConfirm: () => void;
}) {
  const planName = sub?.planName?.trim() || "your plan";
  // Quote what the card is actually charged (Stripe applies the coupon), not list price, or it won't match
  // the invoice. Gated on cyclesLeft: a spent coupon is already detached and this charge is full price.
  const listCents = sub?.priceCents ?? 0;
  const discount = sub?.discount && sub.discount.cyclesLeft > 0 ? sub.discount : null;
  const dueCents = listCents - couponDiscountCents(listCents, discount?.percentOff);
  const discounted = dueCents !== listCents;
  const price = listCents > 0 ? formatMoney(dueCents, sub?.currency) : null;
  const listPrice = listCents > 0 ? formatMoney(listCents, sub?.currency) : null;
  const perInterval = sub?.interval ? `/${sub.interval}` : "";

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      {/* QuickSetupModal is z-[1001] and its dropdowns z-[1100]; below that this opens hidden behind the modal. */}
      <DialogContent className="z-[1200]" overlayClassName="z-[1200]">
        <DialogHeader>
          <DialogTitle>Activate your plan and go live?</DialogTitle>
          <DialogDescription>
            Connecting a number ends your free trial right away.
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-2.5 text-sm">
          <li className="flex items-start gap-2.5">
            <Check className="mt-0.5 size-4 shrink-0 text-primary" />
            <span>
              Your free trial ends now and <span className="font-medium">{planName}</span> activates.
            </span>
          </li>
          <li className="flex items-start gap-2.5">
            <Check className="mt-0.5 size-4 shrink-0 text-primary" />
            <span>
              {price ? (
                <>
                  We charge your saved card{" "}
                  {discounted && (
                    <span className="text-muted-foreground line-through">{listPrice}</span>
                  )}{" "}
                  <span className="font-medium">
                    {price}
                    {perInterval}
                  </span>{" "}
                  today, and your minutes reset to the full plan allowance.
                  {discounted && discount && (
                    <>
                      {" "}
                      <span className="text-muted-foreground">
                        ({discount.code} applied —{" "}
                        {discount.cyclesLeft === 1
                          ? "this charge only"
                          : `${discount.cyclesLeft} charges left`}
                        )
                      </span>
                    </>
                  )}
                </>
              ) : (
                <>We charge your saved card today, and your minutes reset to the full plan allowance.</>
              )}
            </span>
          </li>
          <li className="flex items-start gap-2.5">
            <Check className="mt-0.5 size-4 shrink-0 text-primary" />
            <span>Your number connects to your AI so it can take real calls.</span>
          </li>
        </ul>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {price ? `Activate & pay ${price}` : "Activate & go live"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FlowNode({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div
        className={cn(
          "flex size-12 items-center justify-center rounded-full",
          "bg-primary-tint text-primary",
        )}
      >
        {icon}
      </div>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

function Connector() {
  return <div className="mb-5 h-px w-8 shrink-0 bg-border sm:w-12" />;
}
