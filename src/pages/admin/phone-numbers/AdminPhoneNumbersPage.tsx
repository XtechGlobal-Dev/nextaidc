import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Boxes,
  Check,
  Globe,
  Loader2,
  Phone,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Trash2,
  Users,
  KeyRound,
  MessageSquare,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn, formatDateDMY } from "@/lib/utils";
import {
  DataCard,
  DataCardHeader,
  DataCardPills,
  DataCardGrid,
  CardField,
} from "@/components/ui/data-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Pagination } from "@/components/ui/pagination";
import { api, ApiError } from "@/lib/api";
import { useAuthStore } from "@/stores/useAuthStore";
import { isSuperAdminRole } from "@/lib/roles";
import { useLiveTick } from "@/hooks/useLiveData";
import { usePagination } from "@/hooks/usePagination";
import type { PhonePoolNumber, PhoneUserNumber, PhoneReplenishConfig } from "@/lib/api";
import {
  COUNTRIES,
  ADMIN_COUNTRY_CODES,
  NUMBER_PREFIXES,
  formatNumberPrice,
  flagUrl,
  type NumberPricing,
} from "@/data/countries";
import { AddSystemNumberDialog } from "./AddSystemNumberDialog";
import { AssignNumberDialog } from "./AssignNumberDialog";

type TabKey = "pool" | "user";

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function shortDate(iso: string): string {
  return formatDateDMY(iso);
}

function errMsg(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : fallback;
}

function StatCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">{label}</p>
        <Phone className="size-4 text-muted-foreground" />
      </div>
      <p className="mt-1 text-3xl font-semibold tracking-tight">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
    </Card>
  );
}

export default function AdminPhoneNumbersPage() {
  const [pool, setPool] = useState<PhonePoolNumber[]>([]);
  const [userNumbers, setUserNumbers] = useState<PhoneUserNumber[]>([]);
  const [senderNumber, setSenderNumber] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [tab, setTab] = useState<TabKey>("pool");
  const [search, setSearch] = useState("");
  const [senderDraft, setSenderDraft] = useState("");
  const [testTo, setTestTo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [confirmUnassignSms, setConfirmUnassignSms] = useState(false);
  // Cleanup permanently removes orphaned numbers — confirm before running.
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const [assignFor, setAssignFor] = useState<{ id: string; number: string } | null>(null);

  // Auto-replenish config + edit drafts.
  const [replenish, setReplenish] = useState<PhoneReplenishConfig | null>(null);
  const [targetDraft, setTargetDraft] = useState("");
  const [countryDraft, setCountryDraft] = useState("US");
  const [autoPurchase, setAutoPurchase] = useState(false);
  const [userPurchase, setUserPurchase] = useState(false);
  // Countries customers may pick a number from (uppercase ISO codes).
  const [allowedCountries, setAllowedCountries] = useState<string[]>([]);
  // Per-country national prefixes customers may pick (lowercase iso → prefix[]).
  const [allowedPrefixes, setAllowedPrefixes] = useState<Record<string, string[]>>({});
  // Live Twilio pricing per country (lowercase iso → pricing), loaded lazily.
  const [pricing, setPricing] = useState<Record<string, NumberPricing>>({});

  // Capability gates mirroring the server's requirePermission("phone_numbers", …) per route.
  // Denied buttons are omitted from the DOM and handlers no-op.
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canCreate = hasPermission("phone_numbers.create");
  const canEdit = hasPermission("phone_numbers.edit");
  const canDelete = hasPermission("phone_numbers.delete");

  // Super admin gate on top of the capability grants: Twilio maintenance, the shared SMS sender and the
  // auto-stock pool are platform-wide, so brand admins and STAFF never get them. Role AND capability both required.
  const isSuperAdmin = useAuthStore((s) => isSuperAdminRole(s.user?.role));
  const canCleanup = isSuperAdmin && canDelete;
  const canSyncTwilio = isSuperAdmin && canEdit;
  const canAddSystemNumber = isSuperAdmin && canCreate;

  const load = useCallback(async (silent = false) => {
    try {
      const data = await api.admin.phoneNumbers.overview();
      setPool(data.pool);
      setUserNumbers(data.userNumbers);
      setSenderNumber(data.smsSender);
      return true;
    } catch (e) {
      if (!silent) toast.error(errMsg(e, "Couldn't load phone numbers"));
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Live refresh: silently re-pull the number pool + assignments each tick, so
  // purchases/assignments/restocks show up without a manual reload.
  const liveTick = useLiveTick();
  useEffect(() => {
    if (liveTick > 0) void load(true);
  }, [liveTick, load]);

  useEffect(() => {
    api.admin.phoneNumbers
      .replenishConfig()
      .then((cfg) => {
        setReplenish(cfg);
        setTargetDraft(String(cfg.target));
        setCountryDraft(cfg.country);
        setAutoPurchase(cfg.autoPurchase);
        setUserPurchase(cfg.userPurchase);
        setAllowedCountries(cfg.allowedCountries ?? []);
        setAllowedPrefixes(cfg.allowedPrefixes ?? {});
      })
      .catch(() => {});
  }, []);

  // Per-card dirty flags against the server config (`replenish`, null until loaded so Saves stay off).
  // Both Saves write the whole config via saveReplenish, so either commits the other card's edits too.
  const poolDirty =
    replenish != null &&
    (targetDraft !== String(replenish.target) ||
      countryDraft !== replenish.country ||
      autoPurchase !== replenish.autoPurchase ||
      userPurchase !== replenish.userPurchase);

  /* Compared as SETS, not as written: picking a country and unpicking it leaves
   * the same selection in a different order, which is not a change to save. */
  const sameCountries = (a: string[], b: string[]) =>
    a.length === b.length && [...a].sort().join() === [...b].sort().join();
  const samePrefixes = (a: Record<string, string[]>, b: Record<string, string[]>) => {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    // A country whose prefix list is empty and one that was never given a list
    // describe the same thing, so an empty entry must not read as a change.
    return [...keys].every((k) => sameCountries(a[k] ?? [], b[k] ?? []));
  };
  const countriesDirty =
    replenish != null &&
    (!sameCountries(allowedCountries, replenish.allowedCountries ?? []) ||
      !samePrefixes(allowedPrefixes, replenish.allowedPrefixes ?? {}));

  // Used = assigned pool numbers + every dedicated user number (each belongs to a customer).
  const usedNumbers = useMemo(
    () => pool.filter((n) => n.poolStatus === "ASSIGNED").length + userNumbers.length,
    [pool, userNumbers],
  );
  const totalNumbers = pool.length + userNumbers.length;
  const totalPurchase = useMemo(
    () => [...pool, ...userNumbers].reduce((s, n) => s + n.purchasePriceCents, 0),
    [pool, userNumbers],
  );

  const q = search.trim().toLowerCase();
  const filteredPool = useMemo(
    () => (q ? pool.filter((n) => n.number.toLowerCase().includes(q)) : pool),
    [pool, q],
  );
  const filteredUsers = useMemo(
    () =>
      q
        ? userNumbers.filter((n) =>
            `${n.number} ${n.agentName} ${n.userEmail}`.toLowerCase().includes(q),
          )
        : userNumbers,
    [userNumbers, q],
  );

  // One pager drives both sub-tabs — it counts whichever list is on screen, and
  // searching or switching tabs snaps back to the first page.
  const { page, pageSize, total, setPage, setPageSize } = usePagination(
    tab === "pool" ? filteredPool : filteredUsers,
    { resetKey: `${tab}|${q}` },
  );

  // Both tables slice off the shared page offset; only the active one renders.
  const start = (page - 1) * pageSize;
  const pagedPool = useMemo(
    () => filteredPool.slice(start, start + pageSize),
    [filteredPool, start, pageSize],
  );
  const pagedUsers = useMemo(
    () => filteredUsers.slice(start, start + pageSize),
    [filteredUsers, start, pageSize],
  );

  // An action reports back with a plain success message, or `{ error }` when
  // the outcome is bad news that still deserves a reload (e.g. Twilio gone).
  async function runAction(key: string, fn: () => Promise<string | { error: string }>) {
    setBusy(key);
    try {
      const r = await fn();
      if (typeof r === "string") toast.success(r);
      else toast.error(r.error);
      await load();
    } catch (e) {
      toast.error(errMsg(e, "Action failed"));
    } finally {
      setBusy(null);
    }
  }

  // On-demand refresh — the only header action a non-super-admin sees.
  async function refresh() {
    setBusy("refresh");
    try {
      if (await load()) toast.success("Phone numbers refreshed");
    } finally {
      setBusy(null);
    }
  }

  const cleanupOrphaned = () => {
    if (!canCleanup) return;
    return runAction("cleanup", async () => {
      const r = await api.admin.phoneNumbers.cleanupOrphaned();
      return r.removed ? `Removed ${r.removed} orphaned number${r.removed > 1 ? "s" : ""}` : "No orphaned numbers found";
    });
  };

  const clearSync = () => {
    if (!canSyncTwilio) return;
    return runAction("sync", async () => {
      const r = await api.admin.phoneNumbers.clearSync();
      return r.changed ? `Reset ${r.changed} stuck number${r.changed > 1 ? "s" : ""} to active` : "No numbers needed a reset";
    });
  };

  const resyncTwilio = () => {
    if (!canSyncTwilio) return;
    return runAction("resync", async () => {
      const r = await api.admin.phoneNumbers.resyncTwilio();
      if (!r.configured) {
        return { error: `Twilio disconnected — purged ${r.purged} stored number${r.purged === 1 ? "" : "s"}` };
      }
      return `Twilio: ${r.owned} owned, ${r.inPool} in pool, ${r.missing} not imported`;
    });
  };

  async function assignSenderNumber() {
    const v = senderDraft.trim();
    if (!v || !canEdit || !isSuperAdmin) return;
    setBusy("sms");
    try {
      const r = await api.admin.phoneNumbers.assignSms(v);
      setSenderDraft("");
      toast.success(`SMS sender set to ${r.smsSender}`);
      await load();
    } catch (e) {
      toast.error(errMsg(e, "Couldn't set the SMS sender"));
    } finally {
      setBusy(null);
    }
  }

  async function unassignSenderNumber() {
    if (!canEdit || !isSuperAdmin) return;
    setBusy("sms");
    try {
      await api.admin.phoneNumbers.unassignSms();
      setConfirmUnassignSms(false);
      toast.success("SMS sender cleared");
      await load();
    } catch (e) {
      toast.error(errMsg(e, "Couldn't clear the SMS sender"));
    } finally {
      setBusy(null);
    }
  }

  async function sendTest() {
    const to = testTo.trim();
    if (!to || !canEdit || !isSuperAdmin) return;
    setBusy("test");
    try {
      await api.admin.phoneNumbers.testSms(to);
      toast.success(`Test SMS sent to ${to}`);
    } catch (e) {
      toast.error(errMsg(e, "Couldn't send the test SMS"));
    } finally {
      setBusy(null);
    }
  }

  function toggleCountry(code: string) {
    setAllowedCountries((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  }

  // A prefix is "on" when the country has no explicit list yet (all allowed) or the
  // list includes it. Toggling materializes the full list first, then flips one.
  function isPrefixOn(iso: string, value: string): boolean {
    const list = allowedPrefixes[iso];
    return list === undefined ? true : list.includes(value);
  }

  function togglePrefix(iso: string, value: string) {
    setAllowedPrefixes((prev) => {
      const all = (NUMBER_PREFIXES[iso] ?? []).map((p) => p.value);
      const current = prev[iso] ?? all;
      const next = current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value];
      return { ...prev, [iso]: next };
    });
  }

  const allowed = new Set(ADMIN_COUNTRY_CODES as readonly string[]);
  const adminCountries = COUNTRIES.filter((c) => allowed.has(c.code));
  const prefixCountries = adminCountries.filter(
    (c) => allowedCountries.includes(c.code.toUpperCase()) && NUMBER_PREFIXES[c.code],
  );
  const prefixCountryKey = prefixCountries.map((c) => c.code).join(",");

  // Load live Twilio pricing for each selected prefix-country (once each).
  useEffect(() => {
    prefixCountries.forEach((c) => {
      if (pricing[c.code]) return;
      api.profile
        .numberPricing(c.code.toUpperCase())
        .then((p) => setPricing((prev) => ({ ...prev, [c.code]: p })))
        .catch(() => {});
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefixCountryKey]);

  async function saveReplenish() {
    if (!canEdit) return;
    const target = parseInt(targetDraft, 10);
    setBusy("saveReplenish");
    try {
      const cfg = await api.admin.phoneNumbers.saveReplenishConfig({
        target: Number.isFinite(target) ? target : undefined,
        autoPurchase,
        userPurchase,
        country: countryDraft.trim().toUpperCase() || undefined,
        allowedCountries,
        allowedPrefixes,
      });
      setReplenish(cfg);
      setTargetDraft(String(cfg.target));
      setCountryDraft(cfg.country);
      setAutoPurchase(cfg.autoPurchase);
      setUserPurchase(cfg.userPurchase);
      setAllowedCountries(cfg.allowedCountries ?? []);
      setAllowedPrefixes(cfg.allowedPrefixes ?? {});
      // Holds are dated from the current setting, so a changed window re-dates every countdown — reload.
      void load(true);
      toast.success("Auto-stock settings saved");
    } catch (e) {
      toast.error(errMsg(e, "Couldn't save settings"));
    } finally {
      setBusy(null);
    }
  }

  async function replenishNow() {
    if (!canCreate || !isSuperAdmin) return;
    setBusy("replenishNow");
    try {
      const r = await api.admin.phoneNumbers.replenish();
      if (r.skipped === "twilio-not-configured") {
        toast.error("Twilio isn't configured");
      } else if (!r.imported && !r.purchased) {
        toast.info(`Pool already at target (${r.available}/${r.target})`);
      } else {
        toast.success(
          `Pool restocked — imported ${r.imported}, purchased ${r.purchased} (now ${r.available}/${r.target})`,
        );
      }
      await load();
    } catch (e) {
      toast.error(errMsg(e, "Restock failed"));
    } finally {
      setBusy(null);
    }
  }

  // A released number is assignable straight away — it stays in its brand's pool, no cooldown.
  const renderReassign = (n: PhonePoolNumber | PhoneUserNumber) => {
    return canEdit ? (
      <Button variant="outline" size="sm" onClick={() => setAssignFor({ id: n.id, number: n.number })}>
        <Users className="size-4" /> Reassign
      </Button>
    ) : null;
  };

  // Brand column is super admin only — a brand admin only sees their own numbers. Column counts follow.
  const poolCols = isSuperAdmin ? 6 : 5;
  const userCols = isSuperAdmin ? 9 : 8;

  return (
    <div>
      <PageHeader
        title="Phone Number Management"
        subtitle="Manage system pool and user phone numbers"
        actions={
          <>
            <Button variant="outline" disabled={busy === "refresh"} onClick={refresh}>
              {busy === "refresh" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              Refresh
            </Button>
            {canCleanup && (
              <Button
                variant="outline"
                disabled={busy === "cleanup"}
                onClick={() => setConfirmCleanup(true)}
              >
                {busy === "cleanup" ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                Cleanup Orphaned
              </Button>
            )}
            {canSyncTwilio && (
              <Button variant="outline" disabled={busy === "sync"} onClick={clearSync}>
                {busy === "sync" ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
                Clear Sync Status
              </Button>
            )}
            {canSyncTwilio && (
              <Button variant="outline" disabled={busy === "resync"} onClick={resyncTwilio}>
                {busy === "resync" ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
                Re-sync Twilio Credentials
              </Button>
            )}
            {canAddSystemNumber && (
              <Button onClick={() => setAddOpen(true)}>
                <Plus className="size-4" /> Add System Number
              </Button>
            )}
          </>
        }
      />

      <Tabs defaultValue="numbers" className="mt-4">
        <TabsList className="mb-4">
          <TabsTrigger value="numbers">Numbers</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="settings" className="space-y-4">
          {/* Super admin only — SMS sender + auto-stock pool. The country picker below stays for brand admins. */}
          {isSuperAdmin && (
          <div className="grid gap-4 lg:grid-cols-2">
      {/* SMS sender number */}
      <Card className="flex flex-col overflow-hidden p-0">
        <div className="flex items-start gap-3 border-b border-border/60 px-5 py-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary-tint text-primary">
            <MessageSquare className="size-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold leading-tight">SMS Sender Number</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Every post-call summary SMS is sent to your users from this one number.
            </p>
          </div>
        </div>

        <div className="flex flex-1 flex-col gap-4 p-5">
          {senderNumber ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/30 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-base font-semibold tabular-nums text-foreground">{senderNumber}</span>
                <Badge variant="success">Active sender</Badge>
              </div>
              {canEdit && (
                <button
                  type="button"
                  disabled={busy === "sms"}
                  onClick={() => setConfirmUnassignSms(true)}
                  className="shrink-0 text-xs font-medium text-danger hover:underline disabled:opacity-50"
                >
                  Unassign
                </button>
              )}
            </div>
          ) : (
            <p className="rounded-xl border border-dashed border-border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
              No SMS sender set — summaries fall back to each agent’s own number.
            </p>
          )}

          {canEdit && (
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={senderNumber ? "test-to" : "sender"}
              className="text-xs font-medium text-muted-foreground"
            >
              {senderNumber ? "Send a test SMS" : "Assign sender number"}
            </label>
            {senderNumber ? (
              <div className="flex items-center gap-2">
                <Input
                  id="test-to"
                  placeholder="Recipient e.g. +14155551234"
                  value={testTo}
                  onChange={(e) => setTestTo(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && sendTest()}
                  className="flex-1 font-mono"
                />
                <Button variant="outline" onClick={sendTest} disabled={!testTo.trim() || busy === "test"}>
                  {busy === "test" ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                  Send Test
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Input
                  id="sender"
                  placeholder="e.g. +14155551234"
                  value={senderDraft}
                  onChange={(e) => setSenderDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && assignSenderNumber()}
                  className="flex-1 font-mono"
                />
                <Button onClick={assignSenderNumber} disabled={!senderDraft.trim() || busy === "sms"}>
                  {busy === "sms" && <Loader2 className="size-4 animate-spin" />} Assign
                </Button>
              </div>
            )}
          </div>
          )}
        </div>
      </Card>

      {/* Auto-replenish */}
      <Card className="flex flex-col overflow-hidden p-0">
        <div className="flex items-start justify-between gap-3 border-b border-border/60 px-5 py-4">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary-tint text-primary">
              <Boxes className="size-5" />
            </span>
            <div>
              <h3 className="text-sm font-semibold leading-tight">Auto-Stock Number Pool</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Keep at least this many numbers available in the pool. Imports your owned Twilio
                numbers first; only buys new ones when auto-purchase is on.
              </p>
            </div>
          </div>
          {/* Held numbers are NOT stock — they are exactly what auto-stock will
              go and replace, so counting them here would hide a real shortfall. */}
          <Badge variant="neutral" className="shrink-0 whitespace-nowrap tabular-nums">
            {pool.length} / {replenish?.target ?? "—"} in stock
          </Badge>
        </div>

        <div className="flex-1 divide-y divide-border/60 px-5">
          <div className="flex items-center justify-between gap-3 py-3.5">
            <label htmlFor="pool-target" className="text-sm font-medium">
              Minimum pool size
            </label>
            <Input
              id="pool-target"
              type="number"
              min={0}
              max={100}
              value={targetDraft}
              onChange={(e) => setTargetDraft(e.target.value)}
              className="w-20 text-right"
            />
          </div>
          <div className="flex items-center justify-between gap-3 py-3.5">
            <label htmlFor="pool-country" className="text-sm font-medium">
              Purchase country
            </label>
            <Input
              id="pool-country"
              value={countryDraft}
              onChange={(e) => setCountryDraft(e.target.value.toUpperCase().slice(0, 2))}
              placeholder="US"
              className="w-20 text-center font-mono uppercase"
            />
          </div>
          <div className="flex items-center justify-between gap-3 py-3.5">
            <label htmlFor="auto-purchase" className="pr-2">
              <span className="block text-sm font-medium">Auto-purchase from Twilio</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {autoPurchase ? "Buys numbers (costs money)" : "Import-only — never buys"}
              </span>
            </label>
            <Switch id="auto-purchase" checked={autoPurchase} onCheckedChange={setAutoPurchase} />
          </div>
          <div className="flex items-center justify-between gap-3 py-3.5">
            <label htmlFor="user-purchase" className="pr-2">
              <span className="block text-sm font-medium">Let customers buy their own number</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {userPurchase
                  ? "Customers can buy a new Twilio number during setup (costs money)"
                  : "Off — customers only pick from the pool"}
              </span>
            </label>
            <Switch id="user-purchase" checked={userPurchase} onCheckedChange={setUserPurchase} />
          </div>
        </div>

        {(canCreate || canEdit) && (
          <div className="flex items-center justify-end gap-2 border-t border-border/60 bg-muted/30 px-5 py-3">
            {canCreate && (
              <Button variant="outline" onClick={replenishNow} disabled={busy === "replenishNow"}>
                {busy === "replenishNow" ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
                Restock now
              </Button>
            )}
            {canEdit && (
              <Button onClick={saveReplenish} disabled={busy === "saveReplenish" || !poolDirty}>
                {busy === "saveReplenish" && <Loader2 className="size-4 animate-spin" />} Save
              </Button>
            )}
          </div>
        )}
      </Card>
          </div>
          )}

      {/* Customer number countries */}
      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/60 px-5 py-4">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary-tint text-primary">
              <Globe className="size-5" />
            </span>
            <div>
              <h3 className="text-sm font-semibold leading-tight">Customer Number Countries</h3>
              <p className="mt-1 max-w-xl text-sm text-muted-foreground">
                Pick which countries customers can choose a phone number from during setup. Only the
                selected countries show up in their dropdown.
              </p>
            </div>
          </div>
          <Badge variant="primary">{allowedCountries.length} selected</Badge>
        </div>

        <div className="flex flex-col gap-4 p-5">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground">Available countries</p>
            <div className="flex items-center gap-1 text-xs font-medium">
              <button
                type="button"
                onClick={() => setAllowedCountries(adminCountries.map((c) => c.code.toUpperCase()))}
                className="rounded-md px-2 py-1 text-primary transition hover:bg-primary-tint"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={() => setAllowedCountries([])}
                className="rounded-md px-2 py-1 text-muted-foreground transition hover:bg-muted"
              >
                Clear
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {adminCountries.map((c) => {
              const code = c.code.toUpperCase();
              const selected = allowedCountries.includes(code);
              return (
                <button
                  key={c.code}
                  type="button"
                  onClick={() => toggleCountry(code)}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition",
                    selected
                      ? "border-primary bg-primary-tint shadow-sm"
                      : "border-border hover:bg-muted",
                  )}
                >
                  <img
                    src={flagUrl(c.code)}
                    alt=""
                    className="h-3.5 w-5 shrink-0 rounded-sm object-cover"
                  />
                  <span className="truncate font-medium text-foreground">{c.name}</span>
                  <span className="text-xs text-muted-foreground">+{c.dial}</span>
                  {selected && <Check className="ml-auto size-4 shrink-0 text-primary" />}
                </button>
              );
            })}
          </div>
        </div>

        {/* Per-country prefixes — only for selected countries that have prefix options. */}
        {prefixCountries.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              Prefixes shown to customers (per country)
            </p>
            {prefixCountries.map((c) => (
              <div key={c.code} className="rounded-xl border border-border bg-muted/30 p-3">
                <div className="mb-2.5 flex items-center gap-2 text-sm font-medium">
                  <img src={flagUrl(c.code)} alt="" className="h-3.5 w-5 rounded-sm object-cover" />
                  {c.name}
                </div>
                <div className="flex flex-wrap gap-2">
                  {(NUMBER_PREFIXES[c.code] ?? []).map((p) => {
                    const on = isPrefixOn(c.code, p.value);
                    const price = pricing[c.code]?.prices[p.type];
                    return (
                      <button
                        key={p.value}
                        type="button"
                        onClick={() => togglePrefix(c.code, p.value)}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full border py-1 pl-3 text-xs transition",
                          price !== undefined ? "pr-1" : "pr-3",
                          on
                            ? "border-primary bg-primary-tint text-foreground"
                            : "border-border bg-background text-muted-foreground hover:bg-muted",
                        )}
                      >
                        <span className="font-medium">{p.label}</span>
                        {price !== undefined && (
                          <span
                            className={cn(
                              "rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
                              on ? "bg-background text-foreground" : "bg-muted text-muted-foreground",
                            )}
                          >
                            {formatNumberPrice(pricing[c.code]!.currency, price)}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        </div>

        {canEdit && (
          <div className="flex items-center justify-end gap-2 border-t border-border/60 bg-muted/30 px-5 py-3">
            <Button onClick={saveReplenish} disabled={busy === "saveReplenish" || !countriesDirty}>
              {busy === "saveReplenish" && <Loader2 className="size-4 animate-spin" />} Save countries
            </Button>
          </div>
        )}
      </Card>
        </TabsContent>

        <TabsContent value="numbers">
      {/* Stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Pool Size"
          value={String(pool.length)}
          sub="System phone numbers"
        />
        <StatCard label="Used Numbers" value={`${usedNumbers} / ${totalNumbers}`} sub="Pool + user numbers in use" />
        <StatCard label="Purchase Cost" value={money(totalPurchase)} sub="One-time purchase cost" />
      </div>

      {/* Pool / user sub-tabs + search */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex items-center gap-1 rounded-lg bg-muted p-1">
          <TabButton active={tab === "pool"} onClick={() => setTab("pool")}>
            System Pool ({pool.length})
          </TabButton>
          <TabButton active={tab === "user"} onClick={() => setTab("user")}>
            User Numbers ({userNumbers.length})
          </TabButton>
        </div>
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search number, agent, or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {/* Table (desktop) */}
      <Card className="mt-3 hidden overflow-hidden md:block">
        <div className="overflow-x-auto">
          {tab === "pool" ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Phone Number</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  {isSuperAdmin && <th className="px-4 py-3 font-medium">Brand</th>}
                  <th className="px-4 py-3 text-right font-medium">Purchase Price</th>
                  <th className="px-4 py-3 font-medium">Added</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <LoadingRow cols={poolCols} />
                ) : filteredPool.length === 0 ? (
                  <EmptyRow cols={poolCols} label={q ? "No numbers match your search." : "No system pool numbers."} />
                ) : (
                  pagedPool.map((n) => (
                    <tr key={n.id} className="border-b border-border/60 last:border-0 hover:bg-muted/30">
                      <td className="px-4 py-3 font-medium tabular-nums">{n.number}</td>
                      <td className="px-4 py-3">
                        <PoolStatusBadge n={n} />
                      </td>
                      {isSuperAdmin && (
                        <td className="px-4 py-3 max-w-[12rem]">
                          <BrandCell n={n} />
                        </td>
                      )}
                      <td className="px-4 py-3 text-right tabular-nums">{money(n.purchasePriceCents)}</td>
                      <td className="px-4 py-3 text-muted-foreground">{shortDate(n.addedAt)}</td>
                      <td className="px-4 py-3 text-right">{renderReassign(n)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Phone Number</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Agent / User</th>
                  {isSuperAdmin && <th className="px-4 py-3 font-medium">Brand</th>}
                  <th className="px-4 py-3 font-medium">Agent ID</th>
                  <th className="px-4 py-3 text-right font-medium">Purchase Price</th>
                  <th className="px-4 py-3 text-right font-medium">Monthly Price</th>
                  <th className="px-4 py-3 font-medium">Added</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <LoadingRow cols={userCols} />
                ) : filteredUsers.length === 0 ? (
                  <EmptyRow cols={userCols} label={q ? "No numbers match your search." : "No user-owned numbers."} />
                ) : (
                  pagedUsers.map((n) => (
                    <tr key={n.id} className="border-b border-border/60 last:border-0 hover:bg-muted/30">
                      <td className="px-4 py-3 font-medium tabular-nums">{n.number}</td>
                      <td className="px-4 py-3">
                        <PoolStatusBadge n={n} />
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-medium">{n.agentName}</p>
                        <p className="text-xs text-muted-foreground">{n.userEmail}</p>
                      </td>
                      {isSuperAdmin && (
                        <td className="px-4 py-3 max-w-[12rem]">
                          <BrandCell n={n} />
                        </td>
                      )}
                      <td className="px-4 py-3 text-muted-foreground tabular-nums">
                        {n.agentId ? n.agentId.slice(0, 8) : "—"}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{money(n.purchasePriceCents)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{money(n.monthlyPriceCents)}</td>
                      <td className="px-4 py-3 text-muted-foreground">{shortDate(n.addedAt)}</td>
                      <td className="px-4 py-3 text-right">{renderReassign(n)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
        <p className="border-t border-border px-4 py-3 text-center text-xs text-muted-foreground">
          {tab === "pool"
            ? "Shared numbers — Free-plan customers' AI receptionists answer calls on these. Paid customers get their own dedicated number."
            : "Dedicated numbers — each one belongs to a single paid customer."}
        </p>
      </Card>

      {/* Cards (mobile) */}
      <div className="mt-3 space-y-3 md:hidden">
        {loading ? (
          <div className="rounded-[var(--radius-card)] border border-border bg-card px-4 py-12 text-center text-muted-foreground shadow-[var(--shadow-soft)]">
            <Loader2 className="mx-auto size-5 animate-spin" />
          </div>
        ) : (tab === "pool" ? filteredPool : filteredUsers).length === 0 ? (
          <div className="rounded-[var(--radius-card)] border border-border bg-card px-4 py-12 text-center text-muted-foreground shadow-[var(--shadow-soft)]">
            <Phone className="mx-auto mb-2 size-7 opacity-60" />
            {q
              ? "No numbers match your search."
              : tab === "pool"
                ? "No system pool numbers."
                : "No user-owned numbers."}
          </div>
        ) : tab === "pool" ? (
          pagedPool.map((n) => (
            <DataCard key={n.id}>
              <DataCardHeader
                lead={
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary-tint text-primary">
                    <Phone className="size-5" />
                  </span>
                }
                title={<span className="tabular-nums">{n.number}</span>}
                subtitle={`Added ${shortDate(n.addedAt)}`}
                actions={renderReassign(n)}
              />
              <DataCardPills>
                <PoolStatusBadge n={n} />
              </DataCardPills>
              <DataCardGrid>
                <CardField label="Purchase Price">
                  <span className="tabular-nums">{money(n.purchasePriceCents)}</span>
                </CardField>
                {isSuperAdmin && (
                  <CardField label="Brand">
                    <BrandCell n={n} />
                  </CardField>
                )}
              </DataCardGrid>
            </DataCard>
          ))
        ) : (
          pagedUsers.map((n) => (
            <DataCard key={n.id}>
              <DataCardHeader
                lead={
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary-tint text-primary">
                    <Phone className="size-5" />
                  </span>
                }
                title={<span className="tabular-nums">{n.number}</span>}
                subtitle={`Added ${shortDate(n.addedAt)}`}
                actions={renderReassign(n)}
              />
              <DataCardPills>
                <PoolStatusBadge n={n} />
              </DataCardPills>
              <DataCardGrid>
                <CardField label="Agent / User">
                  <span className="block truncate">{n.agentName}</span>
                  <span className="block truncate text-xs font-normal text-muted-foreground">
                    {n.userEmail}
                  </span>
                </CardField>
                <CardField label="Agent ID">
                  <span className="tabular-nums">{n.agentId ? n.agentId.slice(0, 8) : "—"}</span>
                </CardField>
                <CardField label="Purchase Price">
                  <span className="tabular-nums">{money(n.purchasePriceCents)}</span>
                </CardField>
                <CardField label="Monthly Price">
                  <span className="tabular-nums">{money(n.monthlyPriceCents)}</span>
                </CardField>
              </DataCardGrid>
            </DataCard>
          ))
        )}
      </div>

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        noun={tab === "pool" ? "pool numbers" : "user numbers"}
      />
        </TabsContent>
      </Tabs>

      <AddSystemNumberDialog open={addOpen} onClose={() => setAddOpen(false)} onChanged={() => void load()} />
      <AssignNumberDialog
        open={assignFor !== null}
        numberId={assignFor?.id ?? null}
        number={assignFor?.number ?? null}
        onClose={() => setAssignFor(null)}
        onAssigned={() => void load()}
      />

      <Dialog open={confirmUnassignSms} onOpenChange={(o) => !o && setConfirmUnassignSms(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Unassign the SMS sender number?</DialogTitle>
            <DialogDescription>
              Post-call summaries will fall back to each agent’s own number. If this number was carved
              out of the system pool, it returns to the pool as available.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmUnassignSms(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={busy === "sms"} onClick={unassignSenderNumber}>
              {busy === "sms" && <Loader2 className="size-4 animate-spin" />} Unassign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmCleanup} onOpenChange={(o) => !o && busy !== "cleanup" && setConfirmCleanup(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Remove orphaned numbers?</DialogTitle>
            <DialogDescription>
              This permanently deletes every number in the pool that no longer maps to a real
              provider number or user. Removed entries can't be restored from here.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmCleanup(false)}
              disabled={busy === "cleanup"}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={busy === "cleanup"}
              onClick={async () => {
                await cleanupOrphaned();
                setConfirmCleanup(false);
              }}
            >
              {busy === "cleanup" && <Loader2 className="size-4 animate-spin" />} Run cleanup
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TabButton({
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
        "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        active ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function PoolStatusBadge({ n }: { n: PhonePoolNumber }) {
  if (n.poolStatus === "PENDING_APPROVAL") {
    return <Badge variant="warning">Reserved · pending request</Badge>;
  }
  // A number the brand unassigned is theirs to reuse, but only for a while. Say
  // so on the row — otherwise it just disappears from their pool one morning.
  if (n.reclaimAt) {
    const left = daysLeft(n.reclaimAt);
    return (
      <Badge variant="warning">
        {left === 0 ? "Returns to platform today" : `Yours for ${left}d`}
      </Badge>
    );
  }
  const variant = n.status === "active" ? "success" : n.status === "pending" ? "warning" : "neutral";
  return <Badge variant={variant}>{n.status}</Badge>;
}

// Days until reclaim; clamped at 0 so a number the hourly sweep hasn't collected shows as due, never overdue.
function daysLeft(iso: string): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
}

/** The owning tenant, for the platform admin's brand column. */
function BrandCell({ n }: { n: PhonePoolNumber }) {
  if (!n.brandName) return <span className="text-muted-foreground">Shared</span>;
  return <span className="truncate">{n.brandName}</span>;
}

function EmptyRow({ cols, label }: { cols: number; label: string }) {
  return (
    <tr>
      <td colSpan={cols} className="px-4 py-12 text-center text-muted-foreground">
        <Phone className="mx-auto mb-2 size-7 opacity-60" />
        {label}
      </td>
    </tr>
  );
}

function LoadingRow({ cols }: { cols: number }) {
  return (
    <>
      {Array.from({ length: 6 }).map((_, r) => (
        <tr key={r} className="border-b border-border/60 last:border-0">
          {Array.from({ length: cols }).map((_, c) => (
            <td key={c} className="px-4 py-4">
              <Skeleton className={cn("h-4 w-full", c === 0 && "max-w-[120px]")} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
