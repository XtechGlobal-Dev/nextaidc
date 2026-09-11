import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Crown,
  Globe,
  Mail,
  MessageCircle,
  MessageSquare,
  Send,
} from "lucide-react";
import { toast } from "sonner";
import { useAgentStore } from "@/stores/useAgentStore";
import { useProfileStore } from "@/stores/useProfileStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { StatusPill } from "@/components/ui/misc";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PhoneInput } from "@/components/ui/phone-input";
import { mobileError } from "@/data/countries";
import { REPORT_LANGUAGES } from "@/data/reportLanguages";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { AgentConfig } from "@/types";
import { SectionShell } from "../SectionShell";
import { sectionByKey } from "../sectionMeta";

/* ------------------------------------------------------------------ */
/*  Notification Management — one card per channel.                    */
/*  Each channel sends a post-call summary; toggle on/off, set where   */
/*  it goes (blank = account default), and Test sends a sample now.    */
/* ------------------------------------------------------------------ */

type ChannelKind = "email" | "sms" | "whatsapp";

const CHANNEL_FIELD = {
  email: { value: "summaryEmail", toggle: "ownerEmailSummary" },
  sms: { value: "summarySmsNumber", toggle: "ownerSmsSummary" },
  whatsapp: { value: "summaryWhatsAppNumber", toggle: "ownerWhatsAppSummary" },
} as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate the notification destinations in an automations config. A blank field
 * is valid (it falls back to the account default); a non-blank but malformed
 * email / phone number is not — regardless of whether that channel is toggled on,
 * since the field still shows a validation error the user must resolve. Returns
 * one human-facing message per invalid channel — empty when everything checks
 * out. The page-level Save gates on this so an invalid number can't be saved.
 */
export function automationContactErrors(
  a: AgentConfig["automations"],
): string[] {
  const errs: string[] = [];
  const email = a.summaryEmail?.trim();
  if (email && !EMAIL_RE.test(email)) {
    errs.push("Email Summary — enter a valid email address.");
  }
  if (a.summarySmsNumber?.trim() && mobileError(a.summarySmsNumber)) {
    errs.push("SMS Summary — enter a valid mobile number for the selected country.");
  }
  if (a.summaryWhatsAppNumber?.trim() && mobileError(a.summaryWhatsAppNumber)) {
    errs.push("WhatsApp Summary — enter a valid mobile number for the selected country.");
  }
  // Every "Text Info" detail must be complete — a name, a trigger and a message.
  // An incomplete row (enabled or a draft) blocks the save; the owner either
  // finishes it or deletes it. Seeded rows already carry all three.
  for (const item of a.smsOnRequest?.items ?? []) {
    const missing: string[] = [];
    if (!item.label?.trim()) missing.push("a name");
    if (!item.whenToUse?.trim()) missing.push("a trigger");
    if (!item.template?.trim()) missing.push("a message");
    if (missing.length) {
      errs.push(`Text Info — "${item.label?.trim() || "a new detail"}" needs ${missing.join(", ")}.`);
    }
  }
  return errs;
}

type Channels = { email: boolean; sms: boolean; whatsapp: boolean };

const CHANNELS_CACHE_KEY = "hello22_summary_channels";
// Optimistically assume every channel is available until the backend answers,
// so an already-activated channel never flashes as locked (below the upgrade
// strip) and then jump above it once the fetch resolves.
const OPTIMISTIC_CHANNELS: Channels = { email: true, sms: true, whatsapp: true };

/** Last-known channel availability — instant on revisits, refreshed in the background. */
function readCachedChannels(): Channels {
  try {
    const raw = localStorage.getItem(CHANNELS_CACHE_KEY);
    if (raw) return JSON.parse(raw) as Channels;
  } catch {
    /* ignore malformed / unavailable storage */
  }
  return OPTIMISTIC_CHANNELS;
}

export function AutomationsSection() {
  const profile = useProfileStore((s) => s.profile);
  const authEmail = useAuthStore((s) => s.user?.email ?? "");

  // Defaults captured at signup / onboarding. Fall back to the signed-in
  // account's email when the profile field is blank.
  const defaultEmail = profile.email || authEmail;
  const defaultMobile = profile.mobile;

  // Which summary channels this plan includes. Email is always available;
  // SMS / WhatsApp depend on the subscription. Seed from the cached result
  // (instant, no flicker on revisit) and refresh from the backend below.
  const [channels, setChannels] = useState<Channels>(readCachedChannels);
  useEffect(() => {
    let active = true;
    api.notifications
      .channels()
      .then((c) => {
        if (!active) return;
        setChannels(c);
        try {
          localStorage.setItem(CHANNELS_CACHE_KEY, JSON.stringify(c));
        } catch {
          /* ignore unavailable storage */
        }
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  // Email is always included; SMS / WhatsApp depend on the plan. Activated
  // channels render first, then the upgrade strip, then any locked channels.
  const allChannels = [
    { kind: "email" as const, title: "Email Summary", icon: Mail, accountDefault: defaultEmail, available: true },
    { kind: "sms" as const, title: "SMS Summary", icon: MessageSquare, accountDefault: defaultMobile, available: channels.sms },
    { kind: "whatsapp" as const, title: "WhatsApp Summary", icon: MessageCircle, accountDefault: defaultMobile, available: channels.whatsapp },
  ];
  const active = allChannels.filter((c) => c.available);
  const locked = allChannels.filter((c) => !c.available);

  return (
    <SectionShell meta={sectionByKey("automations")}>
      <div className="flex flex-col gap-0.5">
        <h3 className="text-base font-semibold">Notification Management</h3>
        <p className="text-sm text-muted-foreground">
          Each channel sends a post-call summary. Toggle a channel on/off, set where it goes
          (blank = your account default), and use Test to send a sample right now.
        </p>
      </div>

      <ReportLanguageCard />

      <div className="flex flex-col gap-5">
        {/* Activated channels first. */}
        {active.map((c) => (
          <ChannelCard
            key={c.kind}
            kind={c.kind}
            title={c.title}
            icon={c.icon}
            accountDefault={c.accountDefault}
          />
        ))}

        {/* Upgrade strip — only when at least one channel is plan-locked. */}
        {locked.length > 0 && (
          <UpgradeStrip locked={{ sms: !channels.sms, whatsapp: !channels.whatsapp }} />
        )}

        {/* Locked channels stay visible but faded / non-interactive. The distinct
            key remounts the card (clearing the input) if a channel flips to locked. */}
        {locked.map((c) => (
          <ChannelCard
            key={`${c.kind}-locked`}
            kind={c.kind}
            title={c.title}
            icon={c.icon}
            accountDefault={c.accountDefault}
            locked
          />
        ))}
      </div>

    </SectionShell>
  );
}

/** Language for the owner's summaries + transcripts. Default English (no
 *  translation); pick another language to receive everything translated. */
function ReportLanguageCard() {
  const value = useAgentStore((s) => s.config.automations.reportLanguage);
  const updateSection = useAgentStore((s) => s.updateSection);
  // The Select can't hold an empty-string value, so map "" ↔ a sentinel.
  const ENGLISH = "__english__";
  const current = value?.trim() ? value : ENGLISH;

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-center gap-2">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-tint text-primary">
            <Globe className="size-4" />
          </span>
          <CardTitle>Summary &amp; transcript language</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Select
          value={current}
          onValueChange={(v) =>
            updateSection("automations", { reportLanguage: v === ENGLISH ? "" : v })
          }
        >
          <SelectTrigger className="sm:max-w-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ENGLISH}>English (default)</SelectItem>
            {REPORT_LANGUAGES.map((lang) => (
              <SelectItem key={lang} value={lang}>
                {lang}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Your call summaries are delivered in this language. Transcripts are translated
          on-demand when you open a call. Callers still get their summary in the call's own
          language.
        </p>
      </CardContent>
    </Card>
  );
}


/** Upsell banner shown above the premium summary channels when the plan locks them. */
function UpgradeStrip({
  className,
  locked,
}: {
  className?: string;
  locked: { sms: boolean; whatsapp: boolean };
}) {
  const navigate = useNavigate();
  const bothLocked = locked.sms && locked.whatsapp;
  const names = [locked.sms && "SMS", locked.whatsapp && "WhatsApp"].filter(Boolean).join(" & ");

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-premium/40 bg-premium-tint px-4 py-3",
        className,
      )}
    >
      <div className="flex items-center gap-2.5 text-premium">
        <Crown className="size-5 shrink-0" />
        <p className="text-sm font-medium">
          {names} {bothLocked ? "summaries are" : "summary is"} a premium feature — upgrade your
          plan to activate {bothLocked ? "them" : "it"}.
        </p>
      </div>
      <Button size="sm" onClick={() => navigate("/dashboard/plans")}>
        <Crown className="size-4" /> Upgrade
      </Button>
    </div>
  );
}

function ChannelCard({
  className,
  kind,
  title,
  icon: Icon,
  accountDefault,
  locked = false,
}: {
  className?: string;
  kind: ChannelKind;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  accountDefault: string;
  /** Plan doesn't include this channel — render faded and non-interactive. */
  locked?: boolean;
}) {
  const valueKey = CHANNEL_FIELD[kind].value;
  const toggleKey = CHANNEL_FIELD[kind].toggle;
  const isEmail = kind === "email";

  const automations = useAgentStore((s) => s.config.automations);
  const updateSection = useAgentStore((s) => s.updateSection);

  const enabled = automations[toggleKey];
  // Default to the account's signup email / mobile — the field is just the
  // override source for where this channel's summaries are received.
  const [value, setValue] = useState<string>(automations[valueKey] || accountDefault);
  const [testing, setTesting] = useState(false);
  // True once the user edits the field — after that we never auto-refill it, so
  // clearing the input stays cleared (it won't snap back to the account default).
  const touched = useRef(false);

  // Prefill the account default as a real value once it's known (the profile may
  // load after first render). Only while untouched and with no saved override.
  useEffect(() => {
    if (touched.current || value || automations[valueKey] || !accountDefault) return;
    setValue(accountDefault);
  }, [accountDefault, automations, valueKey, value]);

  // The address/number a test (and the live agent) will actually use.
  const destination = value.trim() || accountDefault;

  // Empty stays empty once edited; locked cards show nothing.
  const displayValue = locked ? "" : value;

  const validate = (v: string): string => {
    const t = v.trim();
    if (!t) return ""; // blank → account default
    if (isEmail) return EMAIL_RE.test(t) ? "" : "Enter a valid email address.";
    return mobileError(t) ?? "";
  };

  // Derive the field error straight from the saved override value — the exact
  // thing the page-level Save gates on — so the inline error and the save-block
  // never drift: a blank/removed number shows no error (and saves fine); an
  // invalid one is flagged on load, not only after the user touches the field.
  const error = locked ? "" : validate(automations[valueKey] || "");

  // Every edit flows straight into the agent store so the page-level
  // "Save Changes" button deploys it — no per-card save needed.
  const handleValueChange = (v: string) => {
    touched.current = true;
    setValue(v);
    updateSection("automations", { [valueKey]: v.trim() } as Partial<typeof automations>);
  };

  const handleToggle = (next: boolean) => {
    updateSection("automations", { [toggleKey]: next } as Partial<typeof automations>);
  };

  const handleTest = async () => {
    if (error) return; // invalid override — the inline error already says why
    if (!destination) {
      toast.error("Add a destination (or set your account default) first.");
      return;
    }
    setTesting(true);
    try {
      await api.notifications.testSummary(kind, destination);
      toast.success(`Test summary sent to ${destination}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't send the test summary");
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card
      className={cn("flex flex-col", locked && "opacity-60 pointer-events-none select-none", className)}
      aria-disabled={locked || undefined}
    >
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-tint text-primary">
              <Icon className="size-4" />
            </span>
            <div>
              <CardTitle className="flex items-center gap-2">
                {title}
                {!locked && (
                  <StatusPill
                    label={enabled ? "Active" : "Paused"}
                    tone={enabled ? "success" : "neutral"}
                  />
                )}
              </CardTitle>
            </div>
          </div>
          {/* Locked (plan doesn't include this channel) → show off; the backend
              also refuses to send for un-entitled plans regardless of this flag. */}
          <Switch checked={locked ? false : enabled} disabled={locked} onCheckedChange={handleToggle} />
        </div>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`channel-${kind}`}>{isEmail ? "Email Address" : "Phone Number"}</Label>
          {isEmail ? (
            <Input
              id={`channel-${kind}`}
              type="email"
              placeholder="you@example.com"
              value={displayValue}
              onChange={(e) => handleValueChange(e.target.value)}
              disabled={locked}
              autoComplete="off"
              aria-invalid={!!error}
            />
          ) : (
            <PhoneInput
              id={`channel-${kind}`}
              value={displayValue}
              onChange={handleValueChange}
              placeholder={`${title} number`}
              autoComplete="off"
              aria-invalid={!!error}
            />
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
          <p className="text-xs text-muted-foreground">
            {accountDefault
              ? `Prefilled from your account ${isEmail ? "email" : "mobile"}. Change it to receive summaries somewhere else.`
              : `No account ${isEmail ? "email" : "mobile"} set yet — add one here to receive summaries.`}
          </p>
        </div>

        {/* SMS + WhatsApp: the public "More info" conversation link + how long it lives. */}
        {(kind === "sms" || kind === "whatsapp") && (
          <ConversationLinkControls kind={kind} locked={locked} />
        )}

        <div className="mt-auto flex items-center">
          <Button variant="outline" size="sm" onClick={handleTest} disabled={locked || testing}>
            <Send className="size-4" />
            {testing ? "Sending…" : "Test"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// How long a shared conversation link stays reachable. A non-expiring ("Never")
// link isn't offered — every link is time-boxed; 30 days is the default.
const LINK_VALIDITY_OPTIONS = [
  { hours: 24, label: "24h" },
  { hours: 168, label: "7 days" },
  { hours: 720, label: "30 days" },
] as const;

// Fallback when the stored validity isn't one of the offered options — e.g. a
// legacy config saved with the removed "Never" (0) value. Keeps 30 days visibly
// selected rather than leaving nothing highlighted.
const DEFAULT_LINK_VALIDITY_HOURS = 720;

// Which automations flag each channel's conversation-link toggle drives.
const LINK_TOGGLE_KEY = {
  sms: "smsIncludeConversationLink",
  whatsapp: "whatsAppIncludeConversationLink",
} as const;

/**
 * Per-channel extras (SMS + WhatsApp): toggle the public "More info" conversation
 * link and choose how long it stays valid. The validity is shared across channels
 * (it's a property of the link itself). Both feed straight into the agent store so
 * the page-level "Save Changes" button deploys them — no per-card save.
 */
function ConversationLinkControls({
  kind,
  locked,
}: {
  kind: "sms" | "whatsapp";
  locked: boolean;
}) {
  const automations = useAgentStore((s) => s.config.automations);
  const updateSection = useAgentStore((s) => s.updateSection);

  const toggleKey = LINK_TOGGLE_KEY[kind];
  const enabled = automations[toggleKey];
  // Highlight 30 days for any legacy/out-of-range value (e.g. the removed "Never").
  const rawValidity = automations.conversationLinkValidityHours;
  const validity = LINK_VALIDITY_OPTIONS.some((o) => o.hours === rawValidity)
    ? rawValidity
    : DEFAULT_LINK_VALIDITY_HOURS;
  const channelLabel = kind === "sms" ? "SMS" : "WhatsApp message";

  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-border bg-muted/30 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <Label className="text-sm">Include conversation link</Label>
          <p className="text-xs text-muted-foreground">
            Adds a short “More info” link to the {channelLabel} that opens a page with the
            call summary, recording and transcript.
          </p>
        </div>
        <Switch
          checked={enabled}
          disabled={locked}
          onCheckedChange={(next) =>
            updateSection("automations", { [toggleKey]: next } as Partial<typeof automations>)
          }
        />
      </div>

      {enabled && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">Link stays valid for</Label>
          <div className="flex flex-wrap gap-1.5">
            {LINK_VALIDITY_OPTIONS.map((opt) => (
              <Button
                key={opt.hours}
                type="button"
                size="sm"
                variant={validity === opt.hours ? "primary" : "outline"}
                disabled={locked}
                onClick={() =>
                  updateSection("automations", { conversationLinkValidityHours: opt.hours })
                }
              >
                {opt.label}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
