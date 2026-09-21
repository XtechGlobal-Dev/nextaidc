import { useEffect, useState } from "react";
import { Globe2, LayoutGrid, Mic, Timer, UserPlus } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, BRAND_MODULES } from "@/lib/api";
import { COUNTRIES } from "@/data/countries";
import { listTimeZones } from "@/lib/timezone";
import type { SetupDraft } from "./brandSetupDraft";

// Brand access + product: sign-up policy, modules, trial and default voice. Plans live in BrandPlansTab.

type Props = {
  value: SetupDraft;
  onChange: (patch: Partial<SetupDraft>) => void;
};

/** Radix Select refuses an empty item value, so "use the platform's" needs a
 *  sentinel on the way in and out. */
const NONE = "__none__";

/** Locale defaults + sign-up policy. In the identity card (shown at create too) since both are decided when the brand is signed. */
export function BrandLocaleFields({ value, onChange }: Props) {
  return (
    <div className="space-y-4 border-t border-border pt-4">
      <div>
        <h4 className="flex items-center gap-2 text-sm font-semibold">
          <Globe2 className="size-4 text-primary" /> Customer defaults
        </h4>
        <p className="mt-1 text-xs text-muted-foreground">
          Where this brand's customers usually are. New accounts start here unless their own
          phone number, address or browser says otherwise.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="b-country">Default country</Label>
          <Select
            value={value.defaultCountry || NONE}
            onValueChange={(v) => onChange({ defaultCountry: v === NONE ? "" : v })}
          >
            <SelectTrigger id="b-country" className="mt-2">
              <SelectValue placeholder="Platform default" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Platform default</SelectItem>
              {COUNTRIES.map((c) => (
                <SelectItem key={c.code} value={c.code.toUpperCase()}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="b-timezone">Default timezone</Label>
          <div className="mt-2">
            <SearchableSelect
              value={value.defaultTimezone}
              onChange={(defaultTimezone) => onChange({ defaultTimezone })}
              options={listTimeZones()}
              placeholder="Platform default"
              clearLabel="Platform default"
            />
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div>
          <Label htmlFor="b-signup" className="flex items-center gap-2 text-sm font-medium">
            <UserPlus className="size-4 text-primary" /> Public sign-up
          </Label>
          <p className="text-xs text-muted-foreground">
            On: anyone can create an account on this brand's door. Off: only its admins create
            accounts, and the sign-up screen and onboarding funnel are closed.
          </p>
        </div>
        <Switch
          id="b-signup"
          checked={value.signupMode === "public"}
          onCheckedChange={(checked) => onChange({ signupMode: checked ? "public" : "invite" })}
        />
      </div>
    </div>
  );
}

export function BrandAccessSection({ value, onChange }: Props) {
  const [voices, setVoices] = useState<{ id: string; label: string }[] | null>(null);

  useEffect(() => {
    let active = true;
    api.voices
      .listAll()
      .then((all) => {
        if (!active) return;
        const rows = [...all.elevenlabs, ...all.deepgram].map((v) => ({
          id: v.id,
          label: `${v.name}${v.descriptor ? ` · ${v.descriptor}` : ""}${v.region ? ` · ${v.region}` : ""}`,
        }));
        setVoices(rows);
      })
      .catch(() => active && setVoices([]));
    return () => {
      active = false;
    };
  }, []);

  const intInput = (key: "trialDays" | "trialMinutes", label: string, unit: string) => (
    <div>
      <Label htmlFor={`b-${key}`}>{label}</Label>
      <div className="mt-2 flex items-center gap-2">
        <Input
          id={`b-${key}`}
          type="number"
          min={0}
          inputMode="numeric"
          className="max-w-[10rem]"
          value={value[key] ?? ""}
          placeholder="Platform default"
          onChange={(e) => {
            const raw = e.target.value.trim();
            onChange({ [key]: raw === "" ? null : Number(raw) } as Partial<SetupDraft>);
          }}
        />
        <span className="text-xs text-muted-foreground">{unit}</span>
      </div>
    </div>
  );

  return (
    <div className="space-y-5">
      <Card className="space-y-4 p-5">
        <Head
          icon={LayoutGrid}
          title="Modules"
          blurb="What this brand's customers get. A module switched off disappears from their navigation and its API answers 403 — a brand that sold “no booking” should not have booking quietly working."
        />
        <div className="grid gap-2 sm:grid-cols-2">
          {BRAND_MODULES.map((m) => (
            <label
              key={m.id}
              className="flex cursor-pointer items-start justify-between gap-3 rounded-lg border border-border px-3 py-2.5"
            >
              <span>
                <span className="text-sm font-medium">{m.label}</span>
                <span className="block text-xs text-muted-foreground">{m.description}</span>
              </span>
              <Switch
                checked={value.modules[m.id]}
                onCheckedChange={(on) => onChange({ modules: { ...value.modules, [m.id]: on } })}
                aria-label={m.label}
              />
            </label>
          ))}
        </div>
      </Card>

      <Card className="space-y-4 p-5">
        <Head
          icon={Timer}
          title="Trial"
          blurb="Overrides for this brand's new customers. Blank fields use the platform's trial settings."
        />
        <div className="grid gap-4 sm:grid-cols-3">
          {intInput("trialDays", "Trial length", "days")}
          {intInput("trialMinutes", "Trial minutes", "call minutes")}
          <div>
            <Label htmlFor="b-card">Card at sign-up</Label>
            <Select
              value={value.cardRequired === null ? NONE : value.cardRequired ? "yes" : "no"}
              onValueChange={(v) =>
                onChange({ cardRequired: v === NONE ? null : v === "yes" })
              }
            >
              <SelectTrigger id="b-card" className="mt-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Platform default</SelectItem>
                <SelectItem value="yes">Required</SelectItem>
                <SelectItem value="no">Not required</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </Card>

      <Card className="space-y-4 p-5">
        <Head
          icon={Mic}
          title="Default voice"
          blurb="The voice this brand's new agents start on. Owners can still change it in the AI Brain, within what their plan allows."
        />
        <div className="max-w-md">
          <Select
            value={value.defaultVoiceId || NONE}
            onValueChange={(v) => onChange({ defaultVoiceId: v === NONE ? "" : v })}
          >
            <SelectTrigger id="b-voice">
              <SelectValue placeholder="Platform default" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Platform default</SelectItem>
              {(voices ?? []).map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.label}
                </SelectItem>
              ))}
              {voices && !voices.some((v) => v.id === value.defaultVoiceId) && value.defaultVoiceId && (
                <SelectItem value={value.defaultVoiceId}>{value.defaultVoiceId}</SelectItem>
              )}
            </SelectContent>
          </Select>
          {voices === null && (
            <p className="mt-1 text-xs text-muted-foreground">Loading voice catalogue…</p>
          )}
        </div>
      </Card>
    </div>
  );
}

function Head({
  icon: Icon,
  title,
  blurb,
}: {
  icon: typeof LayoutGrid;
  title: string;
  blurb: string;
}) {
  return (
    <div>
      <h3 className="flex items-center gap-2 text-base font-semibold">
        <Icon className="size-4 text-primary" /> {title}
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">{blurb}</p>
    </div>
  );
}
