import { useEffect, useMemo, useRef, useState } from "react";
import { Play, Pause, Lock, Loader2, ChevronDown, Check, Globe } from "lucide-react";
import { useAgentStore } from "@/stores/useAgentStore";
import { useProfileStore } from "@/stores/useProfileStore";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SectionShell, FieldGroup } from "../SectionShell";
import { VoiceBehaviourTuning } from "./VoiceBehaviourTuning";
import { sectionByKey } from "../sectionMeta";
import { api, type VoiceCatalogItemWithProvider } from "@/lib/api";
import { useVoicePreview } from "@/hooks/useVoicePreview";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { NAME_MAX, GREETING_MAX, clampName } from "@/lib/limits";
import { autoGreeting, isCustomGreeting, resolveGreeting } from "@/lib/compilePrompt";
import { languagesForVoiceProvider } from "@/data/languages";
import { providerForVoiceId } from "@/data/voices";
import { PROFILE_COUNTRIES } from "@/data/profileCountries";
import { guessProfileCountry } from "@/lib/guessCountry";
import { IndustryCombobox } from "@/components/assistant/IndustryCombobox";
import { VoiceGenderBadge } from "@/components/VoiceGenderBadge";
import { SearchableSelect } from "@/components/ui/searchable-select";

// Country display names for the searchable picker (profile.country stores the name).
const COUNTRY_NAMES = PROFILE_COUNTRIES.map((c) => c.label);

/** A curated voice's ISO language code → the Languages chip it implies. Picking
 *  such a voice auto-enables its language — a Hindi voice with Hindi off would
 *  never actually speak Hindi to a caller. English ("en") maps to nothing on
 *  purpose: English is the always-on base, no chip to flip. */
const VOICE_IMPLIED_LANGUAGE: Record<string, string> = {
  hi: "Hindi",
  pa: "Punjabi",
  zh: "Chinese (Mandarin)",
};

export function IdentitySection() {
  const identity = useAgentStore((s) => s.config.identity);
  const update = useAgentStore((s) => s.updateSection);
  const profileCountry = useProfileStore((s) => s.profile.country);
  const profileIndustry = useProfileStore((s) => s.profile.industry);
  const profileAddress = useProfileStore((s) => s.profile.address);
  const profileMobile = useProfileStore((s) => s.profile.mobile);
  const updateProfile = useProfileStore((s) => s.updateProfile);
  const recompilePrompt = useAgentStore((s) => s.regenerateMasterPrompt);
  const noteContextChange = useAgentStore((s) => s.noteContextChange);
  const isDirtyPrompt = useAgentStore((s) => s.config.advanced.masterPromptDirty);

  // A newly-onboarded user lands here with Country / Region unset. Pre-fill it
  // once from what onboarding captured — their business address, else their mobile
  // number's country — so it's not "Not set". Runs only while it's genuinely empty
  // (a once-per-mount guard lets the user clear it without it snapping back), and
  // doesn't mark the section dirty — it's a silent, sensible default, not an edit.
  const autoCountryDone = useRef(false);
  useEffect(() => {
    if (autoCountryDone.current || profileCountry) return;
    const guess = guessProfileCountry(profileAddress, profileMobile);
    if (!guess) return;
    autoCountryDone.current = true;
    updateProfile({ country: guess });
  }, [profileCountry, profileAddress, profileMobile, updateProfile]);

  const set = (patch: Partial<typeof identity>) => update("identity", patch);

  /** Owner-written greeting? Drives the helper text + Reset affordance, and is
   *  the same test that decides whether a business rename may rewrite it. */
  const greetingIsCustom = isCustomGreeting(identity.greetingMessage);

  /** Renaming the business must carry through to the opening greeting — it stores
   *  the name baked in ("Thanks for calling Acme…"), so without this the agent
   *  kept greeting callers with the old name. Only a greeting we generated is
   *  rewritten; one the owner customised is left as-is. */
  const setBusinessName = (businessName: string) =>
    set({
      businessName,
      greetingMessage: resolveGreeting(identity.greetingMessage, businessName),
    });

  /** The name the rest of the config's free text was written against. Onboarding
   *  generates scenarios/FAQs/facts that name the business ("existing customer of
   *  Acme"), so a rename has to sweep those too — from the last saved name, since
   *  the owner may rename several times before saving. */
  const savedBusinessName = useAgentStore((s) => s.savedConfig.identity?.businessName ?? "");
  const propagateBusinessRename = useAgentStore((s) => s.propagateBusinessRename);
  const renameBaseRef = useRef(savedBusinessName);
  useEffect(() => {
    renameBaseRef.current = savedBusinessName;
  }, [savedBusinessName]);

  /** Sweep on blur rather than per keystroke — mid-typing the name is only half
   *  written ("i", "in", "ins"), and renaming the config against a partial name
   *  would corrupt the text it's meant to keep in sync. */
  const commitBusinessRename = () => {
    const previous = renameBaseRef.current.trim();
    const current = identity.businessName.trim();
    if (!current || previous === current) return;
    propagateBusinessRename(previous);
    renameBaseRef.current = current;
  };

  // Multilingual entitlement — null while loading, then the plan's flag.
  const [multilingual, setMultilingual] = useState<boolean | null>(null);
  // Languages offered depend on the picked voice: the ElevenLabs-only ones
  // (Punjabi, Mandarin) are hidden on a Deepgram voice, which can't speak them.
  // Derived from the voice id itself (not the loaded catalog) so it's correct on
  // first render, before /api/voices resolves. Mirrors the server's save-time strip.
  const offeredLanguages = languagesForVoiceProvider(
    providerForVoiceId(identity.voiceId, "elevenlabs"),
  );
  // Ignore stale entries a config saved against an older, larger catalogue (or
  // against a different voice provider) — the server drops them on save; the UI
  // must never show what it can't offer.
  const selectedLanguages = (identity.languages ?? []).filter((l) =>
    offeredLanguages.includes(l),
  );

  useEffect(() => {
    let active = true;
    api.notifications
      .channels()
      .then((c) => {
        if (active) setMultilingual(c.multilingual);
      })
      .catch(() => {
        if (active) setMultilingual(false);
      });
    return () => {
      active = false;
    };
  }, []);

  function toggleLanguage(lang: string) {
    set({
      languages: selectedLanguages.includes(lang)
        ? selectedLanguages.filter((l) => l !== lang)
        : [...selectedLanguages, lang],
    });
  }

  const [voices, setVoices] = useState<VoiceCatalogItemWithProvider[] | null>(null);
  const [current, setCurrent] = useState<VoiceCatalogItemWithProvider | null>(null);
  // Locked = user can't change voice yet (trial / no active plan / plan without a
  // Voice Bank category) → they stay on the default voice.
  const [locked, setLocked] = useState(false);
  const [category, setCategory] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const { playingId, toggle, stop: stopPreview } = useVoicePreview();
  /** Preview a catalog voice in its own language, surfacing why if it won't play. */
  const togglePreview = (v: VoiceCatalogItemWithProvider) =>
    toggle(v.id, v.provider, {
      language: v.language,
      gender: v.gender,
      onError: (message) => toast.error(`${v.name}: ${message}`),
    });
  const pickerRef = useRef<HTMLDivElement | null>(null);
  // Opens the list upward when the trigger sits too close to the bottom of the
  // viewport for the dropdown (max-h-72 ≈ 288px) to fit below it.
  const [dropUp, setDropUp] = useState(false);

  function toggleOpen() {
    if (!open && pickerRef.current) {
      const rect = pickerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setDropUp(spaceBelow < 300 && rect.top > spaceBelow);
    }
    setOpen((o) => !o);
  }

  // While open, re-evaluate the direction on scroll/resize so the list snaps
  // back below the trigger as soon as there's room again.
  useEffect(() => {
    if (!open) return;
    const reposition = () => {
      if (!pickerRef.current) return;
      const rect = pickerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setDropUp(spaceBelow < 300 && rect.top > spaceBelow);
    };
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await api.voices.list();
        if (!active) return;
        setVoices(res.voices);
        setCurrent(res.current ?? null);
        setLocked(Boolean(res.locked));
        setCategory(res.category ?? null);
      } catch {
        if (active) setVoices([]);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Close the dropdown on outside click.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Accent (region) + gender filters narrow the picker list. "all" = no filter.
  const [accentFilter, setAccentFilter] = useState<string>("all");
  const [genderFilter, setGenderFilter] = useState<"all" | "female" | "male">("all");

  // Accent options come from the loaded catalog itself, so they always match
  // whatever regions the user's plan actually offers.
  const accents = useMemo(
    () => [...new Set((voices ?? []).map((v) => v.region))].sort(),
    [voices],
  );

  const filteredVoices = useMemo(
    () =>
      (voices ?? []).filter(
        (v) =>
          (accentFilter === "all" || v.region === accentFilter) &&
          (genderFilter === "all" || v.gender === genderFilter),
      ),
    [voices, accentFilter, genderFilter],
  );

  const voicesByRegion = useMemo(() => {
    const groups: Record<string, VoiceCatalogItemWithProvider[]> = {};
    for (const v of filteredVoices) (groups[v.region] ??= []).push(v);
    return groups;
  }, [filteredVoices]);

  // The selected voice: the matching entry in the choosable list, else whatever the
  // agent is currently on (covers the locked case where the list is empty).
  const selectedVoice = voices?.find((v) => v.id === identity.voiceId) ?? current ?? null;

  // When a voice pick flips the assistant's gender (female ↔ male), prompt the
  // user to rename the assistant so the name still suits the voice callers hear.
  const [genderSwitch, setGenderSwitch] = useState<{
    from: "male" | "female";
    to: "male" | "female";
    voiceName: string;
  } | null>(null);
  const [nameDraft, setNameDraft] = useState("");

  function chooseVoice(v: VoiceCatalogItemWithProvider) {
    const prevGender = selectedVoice?.gender;
    // A language-specific voice switches the language selection to ITS language —
    // replacing whatever was picked before, so the enabled languages always match
    // the voice callers hear (the user can re-add others afterwards). English is
    // untouched: it's the always-on base, not a removable chip. Skipped on plans
    // without multilingual: the server would strip the language on save anyway.
    const implied = v.language ? VOICE_IMPLIED_LANGUAGE[v.language] : undefined;
    const autoSwitch =
      implied &&
      multilingual !== false &&
      (selectedLanguages.length !== 1 || selectedLanguages[0] !== implied);
    set({
      voiceId: v.id,
      ...(autoSwitch ? { languages: [implied] } : {}),
    });
    if (autoSwitch) toast.success(`Languages set to English + ${implied} to match the ${v.name} voice.`);
    stopPreview();
    setOpen(false);
    if (prevGender && v.gender && prevGender !== v.gender) {
      setNameDraft(identity.assistantName);
      setGenderSwitch({ from: prevGender, to: v.gender, voiceName: v.name });
    }
  }

  const triggerLabel =
    voices === null
      ? "Loading voices…"
      : `Change voice${filteredVoices.length ? ` (${filteredVoices.length} available)` : ""}`;

  return (
    <SectionShell meta={sectionByKey("identity")}>
      <FieldGroup title="Basics" description="The name and business your assistant represents.">
        {/* FieldGroup renders children flush, so the rows carry their own rhythm. */}
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="assistantName">Assistant Name</Label>
                <span className="text-xs text-muted-foreground">
                  {identity.assistantName.length}/{NAME_MAX}
                </span>
              </div>
              <Input
                id="assistantName"
                placeholder="e.g. Sophie"
                maxLength={NAME_MAX}
                value={identity.assistantName}
                onChange={(e) => set({ assistantName: clampName(e.target.value) })}
              />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="businessName">Business Name</Label>
                <span className="text-xs text-muted-foreground">
                  {identity.businessName.length}/{NAME_MAX}
                </span>
              </div>
              <Input
                id="businessName"
                placeholder="Your Business"
                maxLength={NAME_MAX}
                value={identity.businessName}
                onChange={(e) => setBusinessName(clampName(e.target.value))}
                onBlur={commitBusinessRename}
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="profileCountry">Country / Region</Label>
              <SearchableSelect
                id="profileCountry"
                value={profileCountry}
                onChange={(country) => {
                  updateProfile({ country });
                  if (!isDirtyPrompt) setTimeout(recompilePrompt, 0);
                  // Country lives on the profile, so the config alone can't show it
                  // changed — hand the store the values from BEFORE this edit (these
                  // are the rendered ones) so Save Changes enables, and clears again
                  // if they switch back. Must run AFTER updateProfile, which is what
                  // it compares the baseline against.
                  noteContextChange({ country: profileCountry, industry: profileIndustry });
                }}
                options={COUNTRY_NAMES}
                placeholder="Not set"
                searchPlaceholder="Search country…"
                clearLabel="Not set"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="profileIndustry">Industry / Niche</Label>
              <IndustryCombobox
                id="profileIndustry"
                value={profileIndustry}
                onChange={(industry) => {
                  updateProfile({ industry });
                  if (!isDirtyPrompt) setTimeout(recompilePrompt, 0);
                  noteContextChange({ country: profileCountry, industry: profileIndustry });
                }}
              />
            </div>
          </div>

          {/* The exact first line callers hear. Left blank it stays auto-generated
              from the business name and follows a rename; the moment the owner
              writes their own, `resolveGreeting` stops touching it — that's what
              AUTO_GREETING_RE distinguishes, so no extra "customised" flag is
              needed here. */}
          <div className="space-y-1.5">
            <Label htmlFor="greetingMessage">Opening greeting</Label>
            <Input
              id="greetingMessage"
              placeholder={autoGreeting(identity.businessName)}
              maxLength={GREETING_MAX}
              value={identity.greetingMessage}
              onChange={(e) => set({ greetingMessage: e.target.value.slice(0, GREETING_MAX) })}
            />
            <p className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="min-w-0">
              {greetingIsCustom ? (
                <>
                  Your own greeting — it stays exactly as written, even if you rename the business.{" "}
                  <button
                    type="button"
                    onClick={() => set({ greetingMessage: autoGreeting(identity.businessName) })}
                    className="font-medium text-primary underline-offset-2 hover:underline"
                  >
                    Reset to default
                  </button>
                </>
              ) : (
                "The first thing callers hear. Leave it as is and it updates automatically when you rename the business."
              )}
              </span>
              <span className="shrink-0 tabular-nums">
                {identity.greetingMessage.length}/{GREETING_MAX}
              </span>
            </p>
          </div>
        </div>
      </FieldGroup>

      <FieldGroup
        title="Voice Selection"
        description={
          locked
            ? "Your assistant uses the default voice. Choosing a voice unlocks on a paid plan."
            : `Pick the voice your callers will hear${category ? ` from your ${category} voices` : ""}. Tap ▶ to preview.`
        }
      >
        {locked ? (
          /* Read-only: trial / no active plan → the default voice, no picker. */
          <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
              <Lock className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {selectedVoice ? `${selectedVoice.name} · ${selectedVoice.descriptor}` : "Default voice"}
              </p>
              <p className="text-xs text-muted-foreground">
                Voice selection unlocks on a paid plan — until then your assistant uses this default.
              </p>
            </div>
            {selectedVoice && (
              <button
                type="button"
                onClick={() => togglePreview(selectedVoice)}
                className="ml-auto grid size-8 shrink-0 place-items-center rounded-full bg-primary-tint text-primary hover:bg-primary hover:text-primary-foreground"
                aria-label={`Preview ${selectedVoice.name}`}
              >
                {playingId === selectedVoice.id ? (
                  <Pause className="size-3.5 animate-pulse" />
                ) : (
                  <Play className="size-3.5" />
                )}
              </button>
            )}
          </div>
        ) : (
          <>
            {/* The voice callers hear right now — always visible, above the picker. */}
            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Current voice
              </p>
              <div className="flex items-center gap-3 rounded-xl border border-primary/40 bg-gradient-to-br from-primary-tint to-primary-tint-soft px-3 py-2.5">
                {selectedVoice ? (
                  <>
                    <button
                      type="button"
                      onClick={() => togglePreview(selectedVoice)}
                      className="grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
                      aria-label={`Preview ${selectedVoice.name}`}
                    >
                      {playingId === selectedVoice.id ? (
                        <Pause className="size-4 animate-pulse" />
                      ) : (
                        <Play className="size-4" />
                      )}
                    </button>
                    {/* Live equalizer while this voice is previewing. */}
                    {playingId === selectedVoice.id && (
                      <span className="flex items-center gap-[3px]" aria-hidden>
                        {[10, 16, 7, 13, 9].map((h, bi) => (
                          <span
                            key={bi}
                            className="eq-bar w-[2px] rounded-full bg-primary"
                            style={{ height: h, animationDelay: `${bi * 140}ms` }}
                          />
                        ))}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-sm font-medium">
                        <span className="truncate">{selectedVoice.name}</span>
                        <VoiceGenderBadge gender={selectedVoice.gender} />
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {selectedVoice.descriptor} · {selectedVoice.region} accent
                      </p>
                    </div>
                    <Check className="size-4 shrink-0 text-primary" />
                  </>
                ) : (
                  <p className="py-1 text-sm text-muted-foreground">
                    {voices === null ? "Loading voices…" : "No voice selected yet — pick one below."}
                  </p>
                )}
              </div>
            </div>

            {/* Change-voice picker: filter pills narrow the list, then browse. */}
            <div className="mt-4 space-y-2.5 border-t border-border pt-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Change voice
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">Gender</span>
                {/* Segmented control — one background track, the active option
                    filled. Uses the same primary fill as the Accent pills below:
                    a raised card-coloured chip reads fine on a light track but is
                    nearly invisible against the dark-theme muted track, so there
                    was no way to tell which gender was selected. */}
                <div className="inline-flex rounded-full bg-muted p-0.5">
                  {(
                    [
                      { value: "all", label: "All" },
                      { value: "female", label: "Female" },
                      { value: "male", label: "Male" },
                    ] as const
                  ).map((g) => (
                    <button
                      key={g.value}
                      type="button"
                      onClick={() => setGenderFilter(g.value)}
                      className={cn(
                        "rounded-full px-3.5 py-1 text-xs font-semibold transition-colors",
                        genderFilter === g.value
                          ? "bg-primary text-primary-foreground shadow-[var(--shadow-soft)]"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {g.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-0.5 text-xs text-muted-foreground">Accent</span>
                <button
                  type="button"
                  onClick={() => setAccentFilter("all")}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    accentFilter === "all"
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background text-foreground hover:border-primary/40 hover:bg-primary-tint",
                  )}
                >
                  All
                </button>
                {accents.map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => setAccentFilter(a)}
                    className={cn(
                      "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                      accentFilter === a
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-foreground hover:border-primary/40 hover:bg-primary-tint",
                    )}
                  >
                    {a}
                  </button>
                ))}
              </div>

          <div ref={pickerRef} className="relative">
            <button
              type="button"
              onClick={toggleOpen}
              className="flex h-10 w-full items-center justify-between rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              <span className={cn(voices === null && "text-muted-foreground")}>{triggerLabel}</span>
              <ChevronDown
                className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")}
              />
            </button>

            {open && (
              <div
                className={cn(
                  "absolute z-30 max-h-72 w-full overflow-y-auto rounded-lg border border-border bg-card p-1.5 shadow-lg",
                  dropUp ? "bottom-full mb-1.5" : "top-full mt-1.5",
                )}
              >
                {voices !== null && voices.length === 0 && (
                  <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                    No voices available yet.
                  </div>
                )}
                {voices !== null && voices.length > 0 && filteredVoices.length === 0 && (
                  <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                    No voices match these filters — try a different accent or gender.
                  </div>
                )}
                {Object.entries(voicesByRegion).map(([region, list]) => (
                  <div key={region} className="mb-1 last:mb-0">
                    <p className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {region}
                    </p>
                    {list.map((v) => {
                      const selected = v.id === identity.voiceId;
                      return (
                        <div
                          key={v.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => chooseVoice(v)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              chooseVoice(v);
                            }
                          }}
                          className={cn(
                            "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                            selected ? "bg-primary-tint" : "hover:bg-muted",
                          )}
                        >
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              togglePreview(v);
                            }}
                            className="grid size-7 shrink-0 place-items-center rounded-full bg-primary-tint text-primary hover:bg-primary hover:text-primary-foreground"
                            aria-label={`Preview ${v.name}`}
                          >
                            {playingId === v.id ? (
                              <Pause className="size-3.5 animate-pulse" />
                            ) : (
                              <Play className="size-3.5" />
                            )}
                          </button>
                          <span className="font-medium">{v.name}</span>
                          <VoiceGenderBadge gender={v.gender} />
                          <span className="truncate text-muted-foreground">· {v.descriptor}</span>
                          {selected && <Check className="ml-auto size-4 shrink-0 text-primary" />}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
            </div>
          </>
        )}

        {voices === null && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> Loading voice catalog…
          </p>
        )}
      </FieldGroup>

      {/* Sits with the voice it tunes (moved here from Advanced, which is about
          the master prompt). Kept BELOW the picker: choosing a voice is the
          common task and has to be visible without scrolling — tuning it is the
          follow-up. */}
      <VoiceBehaviourTuning />

      {/* Voice gender changed → offer to rename the assistant to match. */}
      <Dialog open={genderSwitch !== null} onOpenChange={(o) => !o && setGenderSwitch(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Update your assistant&apos;s name?</DialogTitle>
            <DialogDescription>
              {genderSwitch && (
                <>
                  You switched from a {genderSwitch.from} voice to a {genderSwitch.to} voice (
                  {genderSwitch.voiceName}). Your assistant is still named{" "}
                  <span className="font-medium text-foreground">{identity.assistantName}</span> — you
                  may want to change the name to match the new voice&apos;s gender.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="genderSwitchName">Assistant Name</Label>
            <Input
              id="genderSwitchName"
              value={nameDraft}
              maxLength={NAME_MAX}
              onChange={(e) => setNameDraft(clampName(e.target.value))}
              placeholder={genderSwitch?.to === "male" ? "e.g. Mark" : "e.g. Jessica"}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setGenderSwitch(null)}>
              Keep current name
            </Button>
            <Button
              disabled={!nameDraft.trim() || nameDraft.trim() === identity.assistantName}
              onClick={() => {
                set({ assistantName: clampName(nameDraft.trim()) });
                setGenderSwitch(null);
              }}
            >
              Update name
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <FieldGroup
        title="Languages"
        description={
          multilingual === false
            ? "Your assistant answers in English. Multilingual answering unlocks on a plan that includes it."
            : "Your assistant always speaks English. Pick the extra languages it can switch to when a caller uses them."
        }
      >
        {multilingual === false ? (
          /* Plan without multilingual → English only, with an upgrade hint. */
          <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
              <Lock className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium">English only</p>
              <p className="text-xs text-muted-foreground">
                Upgrade to a multilingual plan to let your assistant answer callers in their own
                language.
              </p>
            </div>
            <Badge variant="premium" className="ml-auto shrink-0">
              Premium
            </Badge>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {/* English is the always-on base language. */}
              <span className="inline-flex cursor-default items-center gap-1.5 rounded-full border border-primary bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground opacity-90">
                <Globe className="size-3.5" /> English
                <Check className="size-3.5" />
              </span>
              {offeredLanguages.map((lang) => {
                const on = selectedLanguages.includes(lang);
                return (
                  <button
                    key={lang}
                    type="button"
                    onClick={() => toggleLanguage(lang)}
                    disabled={multilingual === null}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50",
                      on
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-foreground hover:border-primary/40 hover:bg-primary-tint",
                    )}
                  >
                    {lang}
                    {on && <Check className="size-3.5" />}
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {multilingual === null ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="size-3 animate-spin" /> Checking your plan…
                </span>
              ) : selectedLanguages.length ? (
                <>
                  Your assistant starts calls in English and switches to{" "}
                  {selectedLanguages.join(", ")} whenever a caller uses one of them.
                </>
              ) : (
                "No extra languages selected — your assistant answers in English."
              )}
            </p>
          </>
        )}
      </FieldGroup>

    </SectionShell>
  );
}
