import { useMemo, useState } from "react";
import {
  ChevronDown,
  Clock,
  Globe,
  Mail,
  MapPin,
  MessageSquareText,
  Phone,
  Plus,
  Send,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { useAgentStore } from "@/stores/useAgentStore";
import { useProfileStore } from "@/stores/useProfileStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { StatusPill } from "@/components/ui/misc";
import {
  availableSmsInfoItems,
  buildSmsInfoBody,
  requiredPlaceholders,
  smsInfoKeyFrom,
  MAX_ENABLED_SMS_INFO_ITEMS,
  MAX_SMS_INFO_ITEMS,
  SMS_MAX_LENGTH,
  SMS_PLACEHOLDERS,
  type SmsInfoValues,
} from "@/data/smsInfoItems";
import type { SmsInfoItem } from "@/types";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Text Info to Callers — the catalogue of details the AI may text a  */
/*  caller who asks for one mid-call.                                  */
/* ------------------------------------------------------------------ */

/** Card: the master switch plus one editable row per textable detail. */
export function CallerInfoSmsCard({ locked = false }: { locked?: boolean }) {
  const enabled = useAgentStore((s) => s.config.automations.clientPostCallSms);
  const items = useAgentStore((s) => s.config.automations.smsOnRequest?.items);
  const businessHours = useAgentStore((s) => s.config.rules.businessHours);
  const updateSection = useAgentStore((s) => s.updateSection);
  const profile = useProfileStore((s) => s.profile);
  const authEmail = useAuthStore((s) => s.user?.email ?? "");

  const list = items ?? [];

  // The real business details the templates interpolate — so the counter and
  // preview below show the message the caller will actually receive, not a
  // placeholder-shaped approximation of it.
  const values: SmsInfoValues = useMemo(
    () => ({
      business: profile.businessName ?? "",
      website: profile.website ?? "",
      email: profile.email || authEmail,
      address: profile.address ?? "",
      phone: profile.businessNumber || profile.mobile || "",
      hours: businessHours ?? "",
    }),
    [profile.businessName, profile.website, profile.email, profile.address, profile.businessNumber, profile.mobile, authEmail, businessHours],
  );

  const setItems = (next: SmsInfoItem[]) =>
    updateSection("automations", { smsOnRequest: { items: next } });

  const patchItem = (id: string, patch: Partial<SmsInfoItem>) =>
    setItems(list.map((i) => (i.id === id ? { ...i, ...patch } : i)));

  const removeItem = (id: string) => setItems(list.filter((i) => i.id !== id));

  // The limit is on how many details are ENABLED, not how many exist: a business
  // can keep spare drafts switched off. A newly added detail starts OFF, so it's
  // clearly a draft the owner is writing — never an active default.
  const enabledCount = list.filter((i) => i.enabled).length;
  const atEnableLimit = enabledCount >= MAX_ENABLED_SMS_INFO_ITEMS;
  const atRowLimit = list.length >= MAX_SMS_INFO_ITEMS;
  const atLimit = atEnableLimit || atRowLimit;

  // Turn a detail on/off, refusing to switch on an incomplete detail, or a fourth
  // one past the limit.
  const toggleItem = (id: string, next: boolean) => {
    if (next) {
      const target = list.find((i) => i.id === id);
      if (target) {
        const missing: string[] = [];
        if (!target.label.trim()) missing.push("a name");
        if (!target.whenToUse.trim()) missing.push("a trigger");
        if (!target.template.trim()) missing.push("a message");
        if (missing.length) {
          toast.error("Finish this detail before switching it on.", {
            description: `It still needs ${missing.join(", ")}.`,
          });
          return;
        }
      }
      if (atEnableLimit) {
        toast.error(`You can have up to ${MAX_ENABLED_SMS_INFO_ITEMS} details switched on.`, {
          description: "Turn one off to enable another.",
        });
        return;
      }
    }
    patchItem(id, { enabled: next });
  };

  const addItem = () => {
    if (atEnableLimit) {
      toast.error(`You can have up to ${MAX_ENABLED_SMS_INFO_ITEMS} details switched on.`, {
        description: "Turn one off below to make room for another.",
      });
      return;
    }
    if (atRowLimit) {
      toast.error("You've reached the maximum number of details.", {
        description: "Remove one of the details below to add another.",
      });
      return;
    }
    const key = smsInfoKeyFrom("new detail", list.map((i) => i.key));
    // Prepend, not append: the new row (and its open editor) lands directly under
    // the Add button, so the user edits it without scrolling past the existing rows.
    setItems([
      {
        id: `sms_${key}_${list.length + 1}`,
        key,
        // A clear default name so a fresh row never shows the internal key
        // ("new_detail"); the owner renames it. Kept non-empty so the server's
        // blank-label backfill never turns it into the raw key.
        label: "New detail",
        // Off by default — a new row is a draft the owner writes and then switches
        // on when ready, never an active default. Switching it on is still gated by
        // the "up to 3 on" limit.
        enabled: false,
        whenToUse: "",
        template: "",
        custom: true,
      },
      ...list,
    ]);
  };

  // How many rows will actually be offered on a call — enabled AND able to
  // render. Surfacing this stops the "it's on but nothing happens" support ticket
  // when the profile is missing the detail a template needs.
  const liveCount = availableSmsInfoItems(list, values).length;

  return (
    <Card
      className={cn("flex flex-col", locked && "opacity-60 pointer-events-none select-none")}
      aria-disabled={locked || undefined}
    >
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-tint text-primary">
              <Send className="size-4" />
            </span>
            <div>
              <CardTitle className="flex items-center gap-2">
                Text Info to Callers
                {!locked && (
                  <StatusPill
                    label={enabled ? "Active" : "Paused"}
                    tone={enabled ? "success" : "neutral"}
                  />
                )}
              </CardTitle>
            </div>
          </div>
          <Switch
            checked={locked ? false : enabled}
            disabled={locked}
            onCheckedChange={(next) => updateSection("automations", { clientPostCallSms: next })}
          />
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          When a caller asks for something below, your AI answers out loud, offers to text it,
          and only sends once they say yes. Ask for several at once and they arrive in one text.
          Up to {MAX_ENABLED_SMS_INFO_ITEMS} switched on at a time, each capped at{" "}
          {SMS_MAX_LENGTH} characters so it sends as a single SMS.
        </p>

        {enabled && !locked && liveCount === 0 && (
          <p className="rounded-lg border border-dashed border-border bg-warm px-3 py-2 text-xs text-muted-foreground">
            Nothing can be sent yet — switch a detail on below, and make sure your profile has
            the information its message needs.
          </p>
        )}

        <div className="flex flex-col gap-2 border-b border-border/60 pb-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Details you can text
              </span>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums",
                  enabledCount > 0 ? "bg-success-tint text-success" : "bg-warm text-muted-foreground",
                )}
              >
                {enabledCount} of {MAX_ENABLED_SMS_INFO_ITEMS} on
              </span>
            </div>
            {/* Kept clickable at the limit on purpose: clicking surfaces the
                validation toast rather than a silently dead button. */}
            <Button size="sm" variant="outline" onClick={addItem} aria-disabled={atLimit}>
              <Plus className="size-4" /> Add detail
            </Button>
          </div>
          {atEnableLimit ? (
            <p className="text-xs text-muted-foreground">
              {MAX_ENABLED_SMS_INFO_ITEMS} details switched on — the most allowed. Turn one off to
              add another.
            </p>
          ) : atRowLimit ? (
            <p className="text-xs text-muted-foreground">
              You&apos;ve reached the maximum number of details.
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2.5">
          {list.map((item) => (
            <SmsInfoRow
              key={item.id}
              item={item}
              values={values}
              onChange={(patch) => patchItem(item.id, patch)}
              onToggle={(next) => toggleItem(item.id, next)}
              onRemove={item.custom ? () => removeItem(item.id) : undefined}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/** A recognisable icon per detail, so a row is identifiable at a glance. Custom
 *  details (and anything unmapped) fall back to a generic message icon. */
const SMS_DETAIL_ICONS: Record<string, LucideIcon> = {
  website: Globe,
  email: Mail,
  address: MapPin,
  hours: Clock,
  phone: Phone,
};
const detailIcon = (key: string): LucideIcon => SMS_DETAIL_ICONS[key] ?? MessageSquareText;

/** Append a {{placeholder}} to a template, spacing it from the previous word. */
const appendToken = (template: string, token: string): string =>
  template && !/\s$/.test(template) ? `${template} ${token}` : `${template}${token}`;

/** One textable detail: on/off, what it answers, and the message itself. */
function SmsInfoRow({
  item,
  values,
  onChange,
  onToggle,
  onRemove,
}: {
  item: SmsInfoItem;
  values: SmsInfoValues;
  onChange: (patch: Partial<SmsInfoItem>) => void;
  /** Enable/disable — separate from field edits so it can be refused at the
   *  3-switched-on limit. */
  onToggle: (next: boolean) => void;
  /** Only custom rows can be deleted — a seeded one is switched off instead. */
  onRemove?: () => void;
}) {
  const [open, setOpen] = useState(!item.template);

  // What the caller actually receives. Empty means it can't send: either the
  // template is blank, or it needs a business detail that isn't filled in.
  const preview = buildSmsInfoBody(item, values);
  const missing = requiredPlaceholders(item.template).filter((k) => !values[k]?.trim());
  // The counter + limit track the MESSAGE the owner types (with its placeholders),
  // capped at one SMS segment. The rendered send is clamped to the same ceiling
  // server-side, so a placeholder that expands can't break the single-segment
  // guarantee either.
  const length = item.template.length;
  const atLimit = length >= SMS_MAX_LENGTH;
  // All three fields are required. Name only appears for custom rows (seeded rows
  // carry a fixed name), so it's only flagged there.
  const nameEmpty = item.custom === true && !item.label.trim();
  const triggerEmpty = !item.whenToUse.trim();
  const isEmpty = !item.template.trim();
  const Icon = detailIcon(item.key);

  // Insert a placeholder chip, but never push the message past the character cap.
  const insertToken = (token: string) => {
    const next = appendToken(item.template, token);
    if (next.length > SMS_MAX_LENGTH) {
      toast.error(`A message can be at most ${SMS_MAX_LENGTH} characters.`);
      return;
    }
    onChange({ template: next });
  };

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border transition-colors",
        item.enabled ? "border-primary/25 bg-primary-tint-soft" : "border-border bg-card",
      )}
    >
      <div className="flex items-center gap-2 p-2.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="group flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left"
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Edit"} ${item.label || "detail"}`}
        >
          <span
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors",
              item.enabled ? "bg-primary-tint text-primary" : "bg-warm text-muted-foreground",
            )}
          >
            <Icon className="size-4" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium">{item.label || "Untitled detail"}</span>
            <span
              className={cn(
                "truncate text-xs",
                preview ? "text-muted-foreground" : "italic text-muted-foreground/70",
              )}
            >
              {preview || (missing.length ? `Needs your ${missing.join(", ")}` : "No message set yet")}
            </span>
          </span>
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform group-hover:text-foreground",
              open && "rotate-180",
            )}
          />
        </button>
        <span className="mx-0.5 h-6 w-px shrink-0 bg-border" aria-hidden />
        <div className="flex shrink-0 items-center gap-1.5">
          {onRemove && (
            <button
              type="button"
              onClick={onRemove}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-danger-tint hover:text-danger"
              aria-label={`Remove ${item.label || "detail"}`}
            >
              <Trash2 className="size-4" />
            </button>
          )}
          <Switch
            checked={item.enabled}
            onCheckedChange={onToggle}
            aria-label={`Enable ${item.label || "detail"}`}
          />
        </div>
      </div>

      {open && (
        <div className="flex flex-col gap-3 border-t border-border/70 bg-warm/40 px-3 py-3">
          {item.custom && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`sms-label-${item.id}`}>Name</Label>
              <Input
                id={`sms-label-${item.id}`}
                placeholder="e.g. Parking information"
                value={item.label}
                onChange={(e) => onChange({ label: e.target.value })}
                aria-invalid={nameEmpty || undefined}
              />
              {nameEmpty && <p className="text-xs text-danger">Give this detail a name.</p>}
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`sms-when-${item.id}`}>Send it when</Label>
            <Input
              id={`sms-when-${item.id}`}
              placeholder="the caller asks where they can park"
              value={item.whenToUse}
              onChange={(e) => onChange({ whenToUse: e.target.value })}
              aria-invalid={triggerEmpty || undefined}
            />
            {triggerEmpty ? (
              <p className="text-xs text-danger">Tell your AI when to send this.</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                How your AI recognises that this is what the caller is asking for.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor={`sms-template-${item.id}`}>Message</Label>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums",
                  atLimit ? "bg-danger-tint text-danger" : "bg-warm text-muted-foreground",
                )}
              >
                {length}/{SMS_MAX_LENGTH}
              </span>
            </div>
            <Textarea
              id={`sms-template-${item.id}`}
              rows={2}
              maxLength={SMS_MAX_LENGTH}
              placeholder="Parking is behind the building, entry via {{address}}"
              value={item.template}
              onChange={(e) => onChange({ template: e.target.value.slice(0, SMS_MAX_LENGTH) })}
              aria-invalid={atLimit || isEmpty || undefined}
            />
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Insert:</span>
              {SMS_PLACEHOLDERS.map((p) => (
                <button
                  key={p.token}
                  type="button"
                  onClick={() => insertToken(p.token)}
                  className="rounded-full border border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary hover:text-primary"
                  title={`Insert ${p.token}`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {isEmpty ? (
              <p className="text-xs text-danger">
                Add a message — a detail can&apos;t be switched on without one.
              </p>
            ) : (
              missing.length > 0 && (
                <p className="text-xs text-danger">
                  Won&apos;t send until your profile has: {missing.join(", ")}.
                </p>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}
