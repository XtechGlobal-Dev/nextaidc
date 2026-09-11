import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  CalendarDays,
  Check,
  Clock,
  Loader2,
  PlugZap,
  Unplug,
  Zap,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError } from "@/lib/api";
import type { BookingSettings, DayHours, WorkingHours } from "@/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

// Display order Mon→Sun, but keys are JS weekday indices (0=Sun … 6=Sat).
const DAY_ORDER: { key: string; label: string }[] = [
  { key: "1", label: "Monday" },
  { key: "2", label: "Tuesday" },
  { key: "3", label: "Wednesday" },
  { key: "4", label: "Thursday" },
  { key: "5", label: "Friday" },
  { key: "6", label: "Saturday" },
  { key: "0", label: "Sunday" },
];

function commonTimezones(): string[] {
  try {
    const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
      "timeZone",
    );
    if (all && all.length) return all;
  } catch {
    /* fall through */
  }
  return [
    "UTC",
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "Europe/London",
    "Europe/Paris",
    "Asia/Kolkata",
    "Asia/Dubai",
    "Asia/Singapore",
    "Australia/Sydney",
    "Pacific/Auckland",
  ];
}

/** Stable serialization of the editable settings, for dirty-checking. */
function serialize(s: {
  autoBook: boolean;
  duration: number;
  timezone: string;
  hours: WorkingHours;
}): string {
  const days: Record<string, DayHours> = {};
  for (let d = 0; d < 7; d++) {
    const day = s.hours[String(d)] ?? { open: false, start: "09:00", end: "17:00" };
    days[String(d)] = { open: !!day.open, start: day.start, end: day.end };
  }
  return JSON.stringify({
    autoBook: s.autoBook,
    duration: s.duration,
    timezone: s.timezone,
    days,
  });
}

/** All times of day at 15-minute steps as { value: "HH:mm", label: "9:00 AM" }.
 *  Used for the bookable-hours pickers so open/close always render in 12-hour
 *  AM/PM (matching the rest of the app) regardless of the browser/OS locale —
 *  a native <input type="time"> can't be forced to 12-hour. The stored value
 *  stays 24-hour "HH:mm" (what the backend expects). */
const TIME_OPTIONS: { value: string; label: string }[] = (() => {
  const out: { value: string; label: string }[] = [];
  for (let m = 0; m < 24 * 60; m += 15) {
    const h = Math.floor(m / 60);
    const min = m % 60;
    const value = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    const ap = h < 12 ? "AM" : "PM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    out.push({ value, label: `${h12}:${String(min).padStart(2, "0")} ${ap}` });
  }
  return out;
})();

/** 12-hour AM/PM time picker backed by a "HH:mm" value. */
function TimeSelect({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const known = TIME_OPTIONS.some((o) => o.value === value);
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className="h-9 w-[7.5rem]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {/* Keep an off-grid legacy value visible instead of silently snapping it. */}
        {!known && value && <SelectItem value={value}>{value}</SelectItem>}
        {TIME_OPTIONS.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Card header with a gradient icon chip — the shared look across the tab. */
function SectionHeader({
  icon: Icon,
  title,
  description,
  tone = "primary",
  actions,
}: {
  icon: typeof Zap;
  title: string;
  description: string;
  tone?: "primary" | "success";
  actions?: ReactNode;
}) {
  return (
    <CardHeader className="flex-row flex-wrap items-start gap-4">
      <span
        className={cn(
          "grid size-11 shrink-0 place-items-center rounded-2xl text-white",
          tone === "success"
            ? "bg-gradient-to-br from-success to-success/80 shadow-[0_6px_16px_-6px_hsl(135_59%_49%/0.8)]"
            : "bg-gradient-to-br from-primary to-primary/80 shadow-[0_6px_16px_-6px_hsl(217_84%_55%/0.7)]",
        )}
      >
        <Icon className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <CardTitle>{title}</CardTitle>
        <CardDescription className="mt-1 leading-relaxed">{description}</CardDescription>
      </div>
      {actions}
    </CardHeader>
  );
}

export function SettingsTab() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [email, setEmail] = useState<string | undefined>();
  const [connecting, setConnecting] = useState(false);

  const [autoBook, setAutoBook] = useState(false);
  const [duration, setDuration] = useState(30);
  const [timezone, setTimezone] = useState("UTC");
  const [hours, setHours] = useState<WorkingHours>({});

  // Snapshot of the last-saved state → drives the "unsaved changes" bar.
  const savedSnapshot = useRef<string>("");

  const refresh = () => {
    setLoading(true);
    Promise.all([api.booking.settings(), api.google.status()])
      .then(([s, g]: [BookingSettings, { connected: boolean; email?: string }]) => {
        setAutoBook(s.autoBookEnabled);
        setDuration(s.durationMin);
        setTimezone(s.timezone || "UTC");
        setHours(s.hours);
        setConnected(g.connected);
        setEmail(g.email);
        savedSnapshot.current = serialize({
          autoBook: s.autoBookEnabled,
          duration: s.durationMin,
          timezone: s.timezone || "UTC",
          hours: s.hours,
        });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  // Handle the Google OAuth return (?google=connected|error), then load state.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const g = params.get("google");
    if (g === "connected") toast.success("Google Calendar connected");
    else if (g === "error") toast.error("Couldn't connect Google Calendar — please try again");
    if (g) {
      params.delete("google");
      const qs = params.toString();
      window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""));
    }
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = useMemo(
    () => serialize({ autoBook, duration, timezone, hours }),
    [autoBook, duration, timezone, hours],
  );
  const dirty = !loading && current !== savedSnapshot.current;

  const connect = async () => {
    setConnecting(true);
    try {
      const { url } = await api.google.authUrl();
      window.location.href = url;
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Google Calendar isn't available yet");
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    try {
      await api.google.disconnect();
      setConnected(false);
      setEmail(undefined);
      toast.success("Google Calendar disconnected");
    } catch {
      toast.error("Couldn't disconnect");
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const r = await api.google.test();
      if (r.ok) toast.success(r.message || "Google Calendar is working");
      else toast.error(r.message || "Calendar test failed");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Calendar test failed");
    } finally {
      setTesting(false);
    }
  };

  const setDay = (key: string, patch: Partial<DayHours>) =>
    setHours((h) => {
      const currentDay: DayHours = h[key] ?? { open: false, start: "09:00", end: "17:00" };
      return { ...h, [key]: { ...currentDay, ...patch } };
    });

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.booking.saveSettings({
        autoBookEnabled: autoBook,
        durationMin: duration,
        timezone,
        hours,
      });
      savedSnapshot.current = serialize({ autoBook, duration, timezone, hours });
      // The assistant is re-pushed to the voice provider on save — tell the user
      // whether it took effect so they know their AI is live with the new setting.
      if (res.synced) {
        toast.success("Settings saved — your AI is updated", {
          description: "New booking behaviour is live on your calls now.",
        });
      } else {
        toast.success("Booking settings saved", {
          description: "Your AI will pick this up on its next sync (build/save your AI Brain to apply now).",
        });
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't save settings");
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    // Revert edits back to the last saved snapshot.
    refresh();
  };

  const openDays = DAY_ORDER.filter(({ key }) => hours[key]?.open).length;

  if (loading) return <SettingsSkeleton />;

  return (
    <div className="space-y-6 pb-24">
      {/* Google Calendar + book-on-the-call. Booking is simple: the AI books the
          caller in during the call when auto-booking is on AND the calendar is
          connected — otherwise it takes a message. */}
      <Card className="animate-rise card-glass">
        <SectionHeader
          icon={CalendarDays}
          title="Book on the call"
          description="Let the AI check your Google Calendar and book the caller in during the call — it adds the booking to your calendar and texts the caller a confirmation. Needs Google Calendar connected."
          tone={connected ? "success" : "primary"}
          actions={
            <Badge variant={connected ? "success" : "neutral"}>
              {connected ? "Connected" : "Not connected"}
            </Badge>
          }
        />
        <CardContent className="space-y-5">
          {/* The connection block. */}
          <div
            className={cn(
              "flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-4 transition-colors",
              connected ? "border-success/25 bg-success-tint/40" : "border-border bg-background",
            )}
          >
            <div className="flex min-w-0 items-center gap-3">
              <span
                className={cn(
                  "grid size-10 shrink-0 place-items-center rounded-xl",
                  connected ? "bg-success text-white" : "bg-muted text-muted-foreground",
                )}
              >
                {connected ? <Check className="size-5" strokeWidth={3} /> : <Unplug className="size-5" />}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold">
                  {connected ? "Calendar connected" : "Not connected yet"}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {connected ? email || "Your Google account is linked." : "Connect to enable direct booking."}
                </p>
              </div>
            </div>
            {connected ? (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  onClick={test}
                  disabled={testing}
                  className="gap-2 border-primary/40 font-semibold text-primary hover:bg-primary hover:text-primary-foreground"
                >
                  {testing ? <Loader2 className="size-4 animate-spin" /> : <Activity className="size-4" />}
                  {testing ? "Testing…" : "Test"}
                </Button>
                <Button
                  variant="outline"
                  onClick={disconnect}
                  className="gap-2 border-danger/40 font-semibold text-danger hover:bg-danger hover:text-white"
                >
                  <Unplug className="size-4" /> Disconnect
                </Button>
              </div>
            ) : (
              <Button variant="primary" onClick={connect} disabled={connecting} className="gap-2 font-semibold">
                {connecting ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
                {connecting ? "Redirecting…" : "Connect Google Calendar"}
              </Button>
            )}
          </div>

          {/* The book-directly toggle — the calendar's whole point, so it lives
              in this card, right under the connection it depends on. */}
          <div
            className={cn(
              "flex items-center justify-between gap-3 rounded-2xl border p-4 transition-colors",
              autoBook ? "border-primary/30 bg-primary-tint-soft" : "border-border bg-background",
            )}
          >
            <div>
              <p className="text-sm font-semibold">Allow the AI to book directly</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                On = it books the caller in on the call. Off = it just takes their details.
              </p>
            </div>
            <Switch checked={autoBook} onCheckedChange={setAutoBook} />
          </div>

          {autoBook && !connected && (
            <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-tint px-3 py-2.5 text-sm leading-relaxed text-foreground/80">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              <span>
                <span className="font-semibold text-foreground">Not live yet — </span>
                connect Google Calendar above for direct booking to actually take effect on calls.
              </span>
            </p>
          )}

          {/* Slot settings only matter for booking on the call, so they belong
              in this card too. */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="bk-tz">Timezone</Label>
              {/* Searchable — the full IANA list is hundreds of entries deep. */}
              <SearchableSelect
                id="bk-tz"
                value={timezone}
                onChange={setTimezone}
                options={commonTimezones()}
                placeholder="Select a timezone"
                searchPlaceholder="Search timezones…"
              />
              <p className="text-xs text-muted-foreground">
                Bookable hours and offered slots are read in this timezone.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bk-dur">Slot length (minutes)</Label>
              <Input
                id="bk-dur"
                type="number"
                min={5}
                max={480}
                step={5}
                value={duration}
                onChange={(e) => setDuration(Math.max(5, Math.min(480, Number(e.target.value) || 30)))}
              />
              <p className="text-xs text-muted-foreground">
                How long each booking the AI offers will run.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 3. Bookable hours */}
      <Card className="animate-rise card-glass">
        <SectionHeader
          icon={Clock}
          title="Bookable hours"
          description="The days and times the AI may offer. Slots are generated between open and close, in your timezone."
          actions={
            <span className="rounded-full bg-primary-tint px-3 py-1 text-xs font-semibold text-primary">
              {openDays} {openDays === 1 ? "day" : "days"} open
            </span>
          }
        />
        <CardContent className="space-y-2">
          {DAY_ORDER.map(({ key, label }) => {
            const day = hours[key] ?? { open: false, start: "09:00", end: "17:00" };
            return (
              <div
                key={key}
                className={cn(
                  "flex flex-wrap items-center gap-3 rounded-lg border p-3 transition-colors",
                  day.open
                    ? "border-border bg-background"
                    : "border-transparent bg-muted/40 hover:border-border",
                )}
              >
                <div className="flex w-32 items-center gap-2.5">
                  <Switch checked={day.open} onCheckedChange={(open) => setDay(key, { open })} />
                  <span
                    className={cn(
                      "text-sm font-medium",
                      !day.open && "text-muted-foreground",
                    )}
                  >
                    {label}
                  </span>
                </div>
                {day.open ? (
                  <div className="flex items-center gap-2 text-sm">
                    <TimeSelect
                      label={`${label} opening time`}
                      value={day.start}
                      onChange={(v) => setDay(key, { start: v })}
                    />
                    <span className="text-muted-foreground">to</span>
                    <TimeSelect
                      label={`${label} closing time`}
                      value={day.end}
                      onChange={(v) => setDay(key, { end: v })}
                    />
                  </div>
                ) : (
                  <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
                    Closed
                  </span>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Sticky unsaved-changes pill — appears the moment anything changes so the
          Save action is never missed after toggling a setting far up the page.
          Sized to its content and centred (rather than a full-width bar) so it
          reads as a floating prompt and keeps the settings behind it visible. */}
      {dirty && (
        <div className="pointer-events-none sticky bottom-4 z-30 flex justify-center">
          <div className="animate-rise pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-x-6 gap-y-2 rounded-full border border-primary/30 bg-card py-3 pl-6 pr-3 shadow-[var(--shadow-panel)] ring-4 ring-background/80">
            <p className="flex items-center gap-2.5 whitespace-nowrap text-[15px] font-medium">
              <span className="relative flex size-2.5">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-70 motion-reduce:hidden" />
                <span className="relative inline-flex size-2.5 rounded-full bg-primary" />
              </span>
              Unsaved changes
            </p>
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={discard} disabled={saving}>
                Discard
              </Button>
              <Button onClick={save} disabled={saving} className="gap-2 rounded-full px-5">
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                Save changes
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Loading skeleton matching the Settings layout (3 cards). */
/** Mirrors the real two-card layout: "Book on the call" (connection row +
 *  book-directly toggle + timezone/slot grid) then "Bookable hours" (7 days). */
function SettingsSkeleton() {
  return (
    <div className="space-y-6">
      {/* Book on the call */}
      <Card>
        <CardHeader className="flex-row items-start gap-4">
          <Skeleton className="size-11 shrink-0 rounded-2xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-3.5 w-72" />
          </div>
          <Skeleton className="h-6 w-24 rounded-full" />
        </CardHeader>
        <CardContent className="space-y-5">
          <Skeleton className="h-[72px] w-full rounded-2xl" />
          <Skeleton className="h-[72px] w-full rounded-2xl" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        </CardContent>
      </Card>

      {/* Bookable hours */}
      <Card>
        <CardHeader className="flex-row items-start gap-4">
          <Skeleton className="size-11 shrink-0 rounded-2xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-5 w-36" />
            <Skeleton className="h-3.5 w-64" />
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
