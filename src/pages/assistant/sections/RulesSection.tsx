import { useState, useMemo } from "react";
import {
  ChevronDown,
  Plus,
  Trash2,
  X,
  GitBranch,
  DollarSign,
  Ban,
  Clock,
} from "lucide-react";
import { useAgentStore } from "@/stores/useAgentStore";
import { Input, Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SectionShell, FieldGroup } from "../SectionShell";
import { sectionByKey } from "../sectionMeta";
import {
  browserTimeZone,
  canonicalTimeZone,
  currentTimeIn,
  groupedTimeZones,
  normalizeTimeZone,
  timeZoneLabel,
} from "@/lib/timezone";
import { uid, cn, capitalize } from "@/lib/utils";
import type { ScenarioRule, FixedPriceItem } from "@/types";
import type { ReactNode } from "react";

function Collapsible({
  icon,
  title,
  defaultOpen = false,
  badge,
  children,
}: {
  icon: ReactNode;
  title: string;
  defaultOpen?: boolean;
  badge?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="overflow-hidden rounded-[var(--radius-card)] border border-border bg-card shadow-[var(--shadow-soft)]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-5 py-4 text-left"
      >
        <span className="text-primary">{icon}</span>
        <span className="flex-1 font-semibold">{title}</span>
        {badge}
        <ChevronDown className={cn("size-5 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && <div className="border-t border-border p-5">{children}</div>}
    </div>
  );
}

export function RulesSection() {
  const rules = useAgentStore((s) => s.config.rules);
  const update = useAgentStore((s) => s.updateSection);
  const [chipDraft, setChipDraft] = useState("");

  const set = (patch: Partial<typeof rules>) => update("rules", patch);

  // GET /api/agent resolves the operating timezone from the business's phone
  // number + address at signup and on read, and normalises legacy display
  // labels ("Sydney (AEST/AEDT)"), so a stored zone is expected here. The
  // browser fallback only covers an offline/mock config — not the real path.
  const storedZone = useMemo(() => normalizeTimeZone(rules.timezone), [rules.timezone]);
  const effectiveZone = useMemo(
    () => storedZone || canonicalTimeZone(browserTimeZone()),
    [storedZone],
  );
  // Pass the selected zone so it always has an option to match — otherwise a
  // zone the runtime doesn't list leaves the trigger blank.
  const zoneGroups = useMemo(() => groupedTimeZones(effectiveZone), [effectiveZone]);

  // Scenario handling
  const addScenario = () =>
    set({ scenarioHandling: [{ id: uid("sc"), ifText: "", thenText: "" }, ...rules.scenarioHandling] });
  const updateScenario = (id: string, patch: Partial<ScenarioRule>) =>
    set({ scenarioHandling: rules.scenarioHandling.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
  const removeScenario = (id: string) =>
    set({ scenarioHandling: rules.scenarioHandling.filter((s) => s.id !== id) });

  // Fixed pricing
  const addItem = () =>
    set({
      pricing: { ...rules.pricing, fixedItems: [{ id: uid("fp"), item: "", price: "" }, ...rules.pricing.fixedItems] },
    });
  const updateItem = (id: string, patch: Partial<FixedPriceItem>) =>
    set({
      pricing: {
        ...rules.pricing,
        fixedItems: rules.pricing.fixedItems.map((p) => (p.id === id ? { ...p, ...patch } : p)),
      },
    });
  const removeItem = (id: string) =>
    set({ pricing: { ...rules.pricing, fixedItems: rules.pricing.fixedItems.filter((p) => p.id !== id) } });

  // Decline chips
  const addChip = () => {
    const v = chipDraft.trim();
    if (!v) return;
    set({ declineCalls: [v, ...rules.declineCalls] });
    setChipDraft("");
  };
  const removeChip = (i: number) =>
    set({ declineCalls: rules.declineCalls.filter((_, idx) => idx !== i) });

  return (
    <SectionShell meta={sectionByKey("rules")}>
      <FieldGroup title="Timezone" description="Used for business hours and scheduling.">
        <Select value={effectiveZone} onValueChange={(v) => set({ timezone: v })}>
          <SelectTrigger className="max-w-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {zoneGroups.map(({ region, zones }) => (
              <SelectGroup key={region}>
                <SelectLabel>{region}</SelectLabel>
                {zones.map((tz) => (
                  <SelectItem key={tz} value={tz}>
                    {timeZoneLabel(tz)}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
        <p className="mt-2 text-xs text-muted-foreground">
          Detected from your business number and address — it's currently{" "}
          {currentTimeIn(effectiveZone)} there. Change it if your business runs
          on a different timezone.
        </p>
      </FieldGroup>

      <Collapsible icon={<GitBranch className="size-5" />} title="Scenario Handling" defaultOpen>
        <div className="space-y-3">
          {rules.scenarioHandling.map((s) => (
            <div key={s.id} className="rounded-lg border border-border bg-warm p-3">
              <div className="flex items-start gap-2">
                <Badge variant="primary" className="mt-2 shrink-0">
                  If
                </Badge>
                <Input
                  placeholder="The caller wants to book a job"
                  value={s.ifText}
                  onChange={(e) => updateScenario(s.id, { ifText: capitalize(e.target.value) })}
                />
                <button
                  onClick={() => removeScenario(s.id)}
                  className="mt-2 shrink-0 text-muted-foreground hover:text-danger"
                  aria-label="Remove scenario"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
              <div className="mt-2 flex items-start gap-2">
                <Badge variant="success" className="mt-2 shrink-0">
                  Then
                </Badge>
                <Input
                  placeholder="Capture their details and offer the next slot"
                  value={s.thenText}
                  onChange={(e) => updateScenario(s.id, { thenText: capitalize(e.target.value) })}
                />
                <span className="mt-2 w-4 shrink-0" />
              </div>
            </div>
          ))}
          <Button size="sm" variant="outline" onClick={addScenario}>
            <Plus className="size-4" /> Add Rule
          </Button>
        </div>
      </Collapsible>

      <Collapsible icon={<DollarSign className="size-5" />} title="Pricing Questions">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">How should the assistant handle pricing?</label>
            <Textarea
              rows={3}
              placeholder="e.g. Don't give firm prices — every job is quoted on site. Reassure callers quotes are free."
              value={rules.pricing.behaviour}
              onChange={(e) => set({ pricing: { ...rules.pricing, behaviour: e.target.value } })}
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border bg-warm px-3 py-2.5">
            <div>
              <p className="text-sm font-medium">Fixed Item Pricing</p>
              <p className="text-xs text-muted-foreground">Let the assistant quote set prices.</p>
            </div>
            <Switch
              checked={rules.pricing.fixedItemsEnabled}
              onCheckedChange={(c) => set({ pricing: { ...rules.pricing, fixedItemsEnabled: c } })}
            />
          </div>
          {rules.pricing.fixedItemsEnabled && (
            <div className="space-y-2">
              {rules.pricing.fixedItems.map((p) => (
                <div key={p.id} className="flex items-center gap-2">
                  <Input
                    placeholder="Item (e.g. Standard driveway)"
                    value={p.item}
                    onChange={(e) => updateItem(p.id, { item: e.target.value })}
                  />
                  <Input
                    className="max-w-[40%]"
                    placeholder="Price (e.g. $120/sqm)"
                    value={p.price}
                    onChange={(e) => updateItem(p.id, { price: e.target.value })}
                  />
                  <button
                    onClick={() => removeItem(p.id)}
                    className="shrink-0 text-muted-foreground hover:text-danger"
                    aria-label="Remove item"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              ))}
              <Button size="sm" variant="outline" onClick={addItem}>
                <Plus className="size-4" /> Add Item
              </Button>
            </div>
          )}
        </div>
      </Collapsible>

      <Collapsible icon={<Ban className="size-5" />} title="Calls to Politely Decline">
        <div className="flex flex-wrap gap-2">
          {rules.declineCalls.map((chip, i) => (
            <span
              key={`${chip}-${i}`}
              className="inline-flex items-center gap-1.5 rounded-full bg-danger-tint px-3 py-1 text-sm text-danger"
            >
              {chip}
              <button onClick={() => removeChip(i)} aria-label="Remove">
                <X className="size-3.5" />
              </button>
            </span>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <Input
            placeholder="Add a call type to decline…"
            value={chipDraft}
            onChange={(e) => setChipDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addChip()}
          />
          <Button variant="outline" onClick={addChip}>
            <Plus className="size-4" /> Add
          </Button>
        </div>
      </Collapsible>

      <Collapsible icon={<Clock className="size-5" />} title="Business Hours & Availability">
        <p className="mb-2 text-sm text-muted-foreground">
          Your operating hours — used for how the AI handles calls, and the hours it can book
          appointments within (once Google Calendar is connected in Account Settings).
        </p>
        <Textarea
          rows={3}
          placeholder="Standard business hours, e.g. Mon–Fri 9am–5pm. Closed weekends."
          value={rules.businessHours}
          onChange={(e) => set({ businessHours: e.target.value })}
        />
      </Collapsible>

      {/* Human Handover — hidden for now */}
    </SectionShell>
  );
}
