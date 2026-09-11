import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Info,
  Lightbulb,
  LifeBuoy,
  ListChecks,
  Phone,
  PhoneCall,
  PhoneForwarded,
  Smartphone,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useProfileStore } from "@/stores/useProfileStore";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { env } from "@/lib/env";
import { COUNTRIES, flagUrl, type Country } from "@/data/countries";
import {
  buildGsmCodeTable,
  codeTableHasCheck,
  carrierDocLinks,
  formatDestination,
  dialDestination,
  isForeignDestination,
  internationalPrefix,
  activateCode,
  type GsmCodeRow,
} from "@/data/callForwarding";

/* ------------------------------------------------------------------ *
 *  Call Forwarding help — a standalone guide that walks a customer
 *  through pointing their existing number at their AI. Both tabs (iPhone
 *  and landline) run on the same carrier dial codes, chosen by country +
 *  carrier; iPhone adds the Live Voicemail warning on top.
 * ------------------------------------------------------------------ */

/** A prominent, can't-miss caveat (the iPhone Live Voicemail gotcha, which
 *  silently swallows calls before they ever reach the AI). */
interface GuideWarning {
  title: string;
  body: string;
  steps: string[];
  /** Tip shown right under the steps. */
  tip?: string;
}

/** iPhone-only: Live Voicemail answers on the handset itself, so it defeats
 *  forwarding however it was set up. Shown above the dial codes, which are the
 *  same ones the landline tab lists — a mobile and a landline both forward
 *  through the same carrier network codes. */
const LIVE_VOICEMAIL_WARNING: GuideWarning = {
  title: "Also turn off Live Voicemail — don't skip this",
  body:
    "On iPhone Live Voicemail is on by default. It answers and transcribes your calls on the phone itself, so they never reach your AI — even with forwarding on. Turn it off first:",
  steps: [
    "Open Settings → Apps → Phone (older iOS: Settings → Phone).",
    "Scroll to the bottom and tap Live Voicemail.",
    "Toggle it off.",
  ],
  tip: "After enabling forwarding, call your own number once to confirm it reaches your AI receptionist.",
};

/* -------------------------- Landline dial codes -------------------------- *
 *  Landline forwarding codes depend on the caller's country: US & Canada use
 *  the CLASS star codes (*72 / *73); most other countries use the standard GSM
 *  MMI codes (*21*…# / #21#). Carriers within a country share the same code, so
 *  the carrier picker mainly sets the caveat note. */
type CodeFamily = "us" | "gsm";
interface LandlineCarrier {
  id: string;
  label: string;
  note?: string;
}
interface LandlineInfo {
  family: CodeFamily;
  carriers: LandlineCarrier[];
}

const LANDLINE_INFO: Record<string, LandlineInfo> = {
  us: {
    family: "us",
    carriers: [
      { id: "us-major", label: "Verizon / AT&T / T-Mobile" },
      { id: "us-other", label: "Other / landline", note: "US codes vary by carrier — if these don't work, ask your provider to enable call forwarding." },
    ],
  },
  ca: {
    family: "us",
    carriers: [
      { id: "ca-major", label: "Bell / Rogers / Telus" },
      { id: "ca-other", label: "Other / landline", note: "Canadian codes vary by carrier — if these don't work, ask your provider to enable call forwarding." },
    ],
  },
  gb: {
    family: "gsm",
    carriers: [
      { id: "gb-major", label: "EE / O2 / Vodafone / Three" },
      { id: "gb-other", label: "Other / landline", note: "UK codes vary by carrier — if these don't work, ask your provider to enable call diversion." },
    ],
  },
  au: {
    family: "gsm",
    carriers: [
      { id: "telstra", label: "Telstra" },
      { id: "optus", label: "Optus" },
      { id: "vodafone", label: "Vodafone" },
      { id: "au-other", label: "Other / landline", note: "Landline forwarding can differ by provider — if these don't work, ask them to enable call forwarding." },
    ],
  },
  nz: {
    family: "gsm",
    carriers: [
      { id: "nz-major", label: "Spark / One NZ / 2degrees" },
      { id: "nz-other", label: "Other / landline", note: "NZ codes vary by carrier — if these don't work, ask your provider to enable call forwarding." },
    ],
  },
};

const GENERIC_LANDLINE: LandlineInfo = {
  family: "gsm",
  carriers: [
    { id: "std", label: "Standard GSM codes", note: "These standard codes work on most networks — confirm with your carrier if one is rejected." },
  ],
};

function landlineInfoFor(iso: string): LandlineInfo {
  return LANDLINE_INFO[iso] ?? GENERIC_LANDLINE;
}

/** ISO country (lowercase) inferred from a phone number, if parseable. */
function isoFromPhone(phone: string | undefined): string | undefined {
  const parsed = parsePhoneNumberFromString((phone ?? "").trim());
  return parsed?.country?.toLowerCase();
}

export default function CallForwardingPage() {
  const aiNumber = useProfileStore((s) => s.profile.receptionistNumber);
  const businessNumber = useProfileStore((s) => s.profile.businessNumber);

  return (
    <div>
      <PageHeader
        title="Call Forwarding"
        subtitle="Keep your existing number and forward its calls to your AI receptionist. Choose your device and follow the steps."
      />

      <AiNumberBanner aiNumber={aiNumber} />

      {/* The setup is always shown. Until an AI number is assigned the guides use a
          "your AI number" placeholder, which fills in automatically once it's ready. */}
      <Tabs defaultValue="apple" className="mt-6">
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="apple" className="flex-1 sm:flex-none">
            <Smartphone className="size-4" />
            iPhone
          </TabsTrigger>
          <TabsTrigger value="landline" className="flex-1 sm:flex-none">
            <Phone className="size-4" />
            Landline
          </TabsTrigger>
        </TabsList>

        {/* Both tabs run on the same carrier codes — iPhone just leads with the
            Live Voicemail warning, which only applies there. */}
        <TabsContent value="apple" className="mt-5">
          <div className="space-y-5">
            <WarningAlert warning={LIVE_VOICEMAIL_WARNING} />
            <LandlinePanel aiNumber={aiNumber} businessNumber={businessNumber} />
          </div>
        </TabsContent>
        <TabsContent value="landline" className="mt-5">
          <LandlinePanel aiNumber={aiNumber} businessNumber={businessNumber} />
        </TabsContent>
      </Tabs>

      <TroubleshootingSection />

      <NeedHelpCard />
    </div>
  );
}

/** Collapsible troubleshooting reference — common reasons forwarding doesn't work,
 *  the same for every device, so it lives once at the page level. */
function TroubleshootingSection() {
  const [open, setOpen] = useState(false);
  const items: { title: string; body: string }[] = [
    { title: "Invalid MMI code", body: "Some carriers don't support every forwarding code." },
    { title: "Dual-SIM devices", body: "Make sure you're configuring the correct SIM." },
    { title: "eSIM", body: "Ensure call forwarding is enabled on the active line." },
    { title: "Wrong number format", body: "Use the complete number, including the country and area code." },
    { title: "Live Voicemail", body: "Disable Live Voicemail before testing forwarding on supported iPhones." },
    { title: "Carrier restrictions", body: "Some carriers require forwarding to be enabled using carrier-specific codes." },
  ];
  return (
    <div className="mt-6 overflow-hidden rounded-[var(--radius-card)] border border-border bg-card shadow-[var(--shadow-soft)]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-muted/50"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Wrench className="size-4" />
        </span>
        <span className="flex-1 text-sm font-semibold text-foreground">Troubleshooting</span>
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="border-t border-border px-4 pb-4 pt-3">
          <ul className="space-y-2.5">
            {items.map((it) => (
              <li key={it.title}>
                <p className="text-sm font-medium text-foreground">{it.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{it.body}</p>
              </li>
            ))}
          </ul>
          <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Still not working?</span> Contact your
            carrier or our support team.
          </p>
        </div>
      )}
    </div>
  );
}

/** "Need help setting up?" — a friendly nudge to email support, for owners whose
 *  phone system doesn't match the guides above. Opens a pre-filled email. */
function NeedHelpCard() {
  const mailto = `mailto:${env.supportEmail}?subject=${encodeURIComponent(
    "Help setting up call forwarding",
  )}&body=${encodeURIComponent(
    "Hi, I need help forwarding my calls to my AI number. My phone / carrier is: ",
  )}`;
  return (
    <div className="animate-rise mt-6 rounded-[var(--radius-card)] border border-border bg-card p-6 text-center shadow-[var(--shadow-soft)]">
      <span className="mx-auto mb-3 flex size-11 items-center justify-center rounded-2xl bg-primary-tint text-primary">
        <LifeBuoy className="size-5" />
      </span>
      <p className="text-base font-semibold text-foreground">Still need help?</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
        Our team can help verify your carrier settings and get call forwarding working correctly.
      </p>
      <a
        href={mailto}
        className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-primary transition-colors hover:opacity-80"
      >
        Contact support <ArrowRight className="size-4" />
      </a>
    </div>
  );
}

/* --------------------------------- parts --------------------------------- */

function AiNumberBanner({ aiNumber }: { aiNumber: string }) {
  return (
    <div className="animate-rise relative overflow-hidden rounded-[var(--radius-card)] border border-primary/25 bg-primary-tint-soft p-5 shadow-[var(--shadow-soft)]">
      {/* Soft decorative glows */}
      <div aria-hidden className="pointer-events-none absolute -right-12 -top-16 size-48 rounded-full bg-primary/10 blur-2xl" />
      <div aria-hidden className="pointer-events-none absolute -bottom-16 left-1/3 size-40 rounded-full bg-[#22D3EE]/10 blur-2xl" />
      <div className="relative flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-md">
            <PhoneForwarded className="size-5" />
          </span>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              Forward your calls to
            </p>
            {aiNumber ? (
              <p className="mt-0.5 font-mono text-2xl font-bold leading-none tabular-nums text-foreground">
                {aiNumber}
              </p>
            ) : (
              <p className="mt-0.5 flex items-center gap-2 text-sm text-muted-foreground">
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-warning opacity-60" />
                  <span className="relative inline-flex size-2 rounded-full bg-warning" />
                </span>
                Your AI number is being assigned — the guides below use{" "}
                <span className="font-medium text-foreground">your AI number</span> as a placeholder
                and fill in automatically once it's ready.
              </p>
            )}
          </div>
        </div>
        {aiNumber && <CopyButton value={aiNumber} />}
      </div>
    </div>
  );
}

/** A small flag + name row for a country option. */
function CountryOption({ code, name }: { code: string; name: string }) {
  return (
    <span className="flex items-center gap-2">
      <img
        src={flagUrl(code)}
        alt={`${name} flag`}
        width={20}
        height={15}
        loading="lazy"
        className="h-[15px] w-5 shrink-0 rounded-[2px] object-cover"
      />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** Landline tab: the country dropdown lists only the countries the admin lets
 *  customers pick numbers in; country + carrier drive the dial codes shown. */
function LandlinePanel({ aiNumber, businessNumber }: { aiNumber: string; businessNumber: string }) {
  // Which countries the admin offers numbers in (ISO, lowercase). AU/US stand in
  // until the real list loads so the tab is never empty.
  const [allowed, setAllowed] = useState<string[]>(["au", "us"]);
  useEffect(() => {
    let active = true;
    api.profile
      .numberCountries()
      .then((r) => {
        if (active && r.countries?.length) setAllowed(r.countries.map((c) => c.toLowerCase()));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const options = useMemo(
    () =>
      allowed
        .map((code) => COUNTRIES.find((c) => c.code === code))
        .filter((c): c is Country => Boolean(c)),
    [allowed],
  );

  // Country: derived so we never hold a value that isn't offered. Default to the
  // customer's own number's country when it's in the list, else the first option.
  const [countryPick, setCountryPick] = useState<string>("");
  const detected = isoFromPhone(businessNumber) || isoFromPhone(aiNumber);
  const fallback =
    (detected && options.some((o) => o.code === detected) && detected) || options[0]?.code || "";
  const country = options.some((o) => o.code === countryPick) ? countryPick : fallback;

  const info = landlineInfoFor(country);

  // Carrier: same idea — fall back to the first carrier when the pick doesn't
  // belong to the current country's list (e.g. right after switching country).
  const [carrierPick, setCarrierPick] = useState<string>("");
  const carrier = info.carriers.find((c) => c.id === carrierPick) ?? info.carriers[0];

  const selectedName = options.find((o) => o.code === country)?.name ?? "";

  return (
    <div className="space-y-5">
      {/* Disclaimer first — same top priority as the device tabs. */}
      <CarrierDisclaimer carrier={carrier?.label} />

      {/* Official carrier guides right after the disclaimer, before the pickers. */}
      <CarrierGuides iso={country} countryName={selectedName} />

      {/* Pickers live in their own card so the tab reads as one stack of cards
          instead of loose controls floating on the page background. */}
      <div className="animate-rise rounded-[var(--radius-card)] border border-border bg-card p-4 shadow-[var(--shadow-soft)]">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Where's your phone?
            </label>
            <Select value={country} onValueChange={setCountryPick}>
              <SelectTrigger>
                <SelectValue>
                  {country ? <CountryOption code={country} name={selectedName} /> : "Select country"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {options.map((c) => (
                  <SelectItem key={c.code} value={c.code}>
                    <CountryOption code={c.code} name={c.name} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Carrier
            </label>
            <Select value={carrier?.id ?? ""} onValueChange={setCarrierPick}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {info.carriers.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Short note under the pickers — set expectations before the codes. */}
        <p className="mt-3.5 flex items-start gap-2 border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">
          <Phone className="mt-0.5 size-3.5 shrink-0" />
          <span>
            <span className="font-medium text-foreground">These are carrier network codes.</span>{" "}
            Dial them from the phone number you want to forward.
          </span>
        </p>
      </div>

      {/* Full code reference + official carrier guides right after the pickers —
          the actionable content, reactive to the selected country + carrier. */}
      <ForwardingCodesAccordion
        family={info.family}
        aiNumber={aiNumber}
        carrier={carrier}
        countryName={selectedName}
        iso={country}
      />

      <VerifySetupCard />
    </div>
  );
}

/** Collapsible carrier-style table of every forwarding code for the chosen code
 *  family. The step guide covers the common "all calls" case; this lets a user
 *  look up the code for no-answer / busy / unreachable and how to turn each off. */
function ForwardingCodesAccordion({
  family,
  aiNumber,
  carrier,
  countryName,
  iso,
}: {
  family: "us" | "gsm";
  aiNumber: string;
  carrier: LandlineCarrier;
  countryName: string;
  iso: string;
}) {
  const [open, setOpen] = useState(true);
  // Carrier-aware: Telstra's activate codes carry the *11 voice class.
  const rows = useMemo(() => buildGsmCodeTable(family, carrier.id), [family, carrier.id]);
  const hasCheck = codeTableHasCheck(family);
  const isAustralia = iso === "au";
  const isTelstra = carrier.id === "telstra";
  // The destination the user dials TO, in the form their carrier expects: the
  // national form (0468159801) for a same-country AI number, since the code is a
  // domestic call and a landline keypad has no "+" to key. When their AI number
  // isn't assigned yet we show a placeholder token instead of a broken "**21*+#".
  // US CLASS codes keep their own domestic form (1 + national) for a US number;
  // every other same-country case uses the plain national form.
  const foreignDest = isForeignDestination(aiNumber, iso);
  const dest = foreignDest
    ? formatDestination(aiNumber, "gsm") // no local form here — stays +…
    : family === "us"
      ? formatDestination(aiNumber, family)
      : dialDestination(aiNumber, iso);
  const hasNumber = dest.replace(/\D/g, "").length > 0;

  return (
    <div
      className={cn(
        "animate-rise overflow-hidden rounded-[var(--radius-card)] border bg-primary-tint-soft shadow-[var(--shadow-soft)] transition-colors",
        open ? "border-primary/40" : "border-primary/25 ring-1 ring-primary/10",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-primary/[0.06]"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
          <ListChecks className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-foreground">All forwarding codes</span>
            <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
              Quick reference
            </span>
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            For{" "}
            <span className="font-medium text-foreground">
              {carrier.label}
              {countryName ? `, ${countryName}` : ""}
            </span>{" "}
            — when to use which code, and how to turn it off
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-primary">
          <span className="hidden sm:inline">{open ? "Hide" : "View codes"}</span>
          <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
        </span>
      </button>

      {open && (
        <div className="border-t border-primary/20 bg-card px-4 pb-4 pt-3">
          {/* Telstra-only: the *11 voice class is a required part of Telstra's
              official sequence — call it out so nobody strips it. */}
          {isTelstra && (
            <p className="mb-3 flex gap-2 rounded-lg border border-warning/40 bg-warning-tint px-3 py-2 text-xs leading-relaxed text-foreground/85">
              <Info className="mt-0.5 size-3.5 shrink-0 text-warning" />
              <span>
                <span className="font-semibold text-foreground">Telstra users:</span> the{" "}
                <span className="font-mono">*11#</span> at the end of the forwarding code is
                required. Do not remove or modify it.
              </span>
            </p>
          )}
          {/* The AI number is in a different country from the phone being forwarded,
              so it has no local form there — the code keeps the international one,
              which a landline can't key without its international dial-out prefix. */}
          {foreignDest && hasNumber && (
            <p className="mb-3 flex gap-2 rounded-lg border border-warning/40 bg-warning-tint px-3 py-2 text-xs leading-relaxed text-foreground/85">
              <Info className="mt-0.5 size-3.5 shrink-0 text-warning" />
              <span>
                Your AI number is in another country, so it has no local form here and stays
                international. That works from a mobile; from a landline, replace the{" "}
                <span className="font-mono">+</span> with{" "}
                <span className="font-mono">{internationalPrefix(iso)}</span>
                {countryName ? ` — ${countryName}'s international dialling prefix` : ""} (e.g.{" "}
                <span className="font-mono">
                  {internationalPrefix(iso)}
                  {dest.replace(/^\+/, "")}
                </span>
                ). Forwarding to another country may also be charged at international rates.
              </span>
            </p>
          )}
          {/* Legend — makes it obvious which part of a code is fixed and which part
              is the number the user substitutes. */}
          <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
            Dial each code exactly as shown. The{" "}
            <span className="rounded bg-primary/15 px-1 py-0.5 font-mono font-semibold text-primary">
              highlighted
            </span>{" "}
            part is where <span className="font-medium text-foreground">your AI number</span> goes
            {hasNumber ? " (already filled in below)" : ""}; the rest is the fixed carrier code.
          </p>
          {/* Scroll the wide table on small screens instead of breaking the layout. */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[440px] border-collapse text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3 font-semibold">Scenario</th>
                  <th className="py-2 pr-3 font-semibold">Turn on</th>
                  <th className="py-2 pr-3 font-semibold">Turn off</th>
                  {hasCheck && <th className="py-2 font-semibold">Check</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.scenario} className="align-top transition-colors hover:bg-primary-tint/25">
                    <td className="py-3 pr-3">
                      <p className="font-semibold text-foreground">{r.scenario}</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{r.when}</p>
                    </td>
                    <td className="py-3 pr-3">
                      <ActivateCode row={r} dest={dest} hasNumber={hasNumber} />
                    </td>
                    <td className="py-3 pr-3">
                      <CopyCode value={r.deactivate} />
                    </td>
                    {hasCheck && (
                      <td className="py-3">{r.check ? <CopyCode value={r.check} /> : <span className="text-muted-foreground">—</span>}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Enter a code on your phone's keypad and press call — you'll see or hear a confirmation.
          </p>
          {/* Carrier-specific caveat, else a reassurance that these are the standard
              codes shared across the country's major carriers — so switching between
              them showing the same codes is expected, not a bug. */}
          {carrier.note ? (
            <p className="mt-2 flex gap-2 rounded-lg border border-warning/25 bg-warning-tint px-3 py-2 text-xs leading-relaxed text-foreground/80">
              <Info className="mt-0.5 size-3.5 shrink-0 text-warning" />
              <span>{carrier.note}</span>
            </p>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              These are the standard codes for{" "}
              <span className="font-medium text-foreground">{countryName || "your country"}</span>{" "}
              networks — they work the same across major carriers like {carrier.label}.
            </p>
          )}

          {/* Carrier-doc nuances, verified against Telstra / Optus / Vodafone's own
              pages — kept as notes so the core codes stay simple + universal. These
              are Australia-specific, so only shown for AU (see the country note below). */}
          {family === "gsm" && isAustralia && (
            <div className="mt-3 rounded-xl border border-primary/25 bg-primary-tint-soft p-3.5 shadow-[var(--shadow-soft)]">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                  <Lightbulb className="size-3" />
                </span>
                Good to know
              </p>
              <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-muted-foreground">
                <li>
                  <span className="font-medium text-foreground">Number format:</span> the number
                  above is the local form (leading <span className="font-mono">0</span>, area code
                  included) — that's what carriers expect, and a landline keypad has no{" "}
                  <span className="font-mono">+</span> key. The international{" "}
                  <span className="font-mono">+61…</span> form works from a mobile if you prefer it.
                </li>
                <li>
                  <span className="font-medium text-foreground">Turning off:</span> some carriers
                  (e.g. Vodafone) also accept a single <span className="font-mono">#</span> — e.g.{" "}
                  <span className="font-mono">#21#</span>. <span className="font-mono">##002#</span>{" "}
                  cancels every diversion; <span className="font-mono">##004#</span> cancels only the
                  conditional ones (no answer / busy / unreachable).
                </li>
                <li>
                  <span className="font-medium text-foreground">The trailing *11:</span> on Telstra
                  the activate code ends in <span className="font-mono">*11</span> — it limits
                  forwarding to voice calls (ideal for a receptionist). Other carriers omit it and
                  forward all services; both work for calls.
                </li>
                <li>
                  <span className="font-medium text-foreground">Ring time:</span> some carriers (e.g.
                  Optus) let you set how long it rings before a “no answer” diversion — e.g.{" "}
                  <span className="font-mono">**61*number**20#</span> (20 seconds).
                </li>
                <li>
                  <span className="font-medium text-foreground">Examples:</span> mobile{" "}
                  <span className="font-mono">0412345678</span>, landline{" "}
                  <span className="font-mono">0291234567</span>. Always include the area code when
                  entering Australian numbers.
                </li>
              </ul>
            </div>
          )}

          {/* Non-Australia: our detailed carrier notes are AU-specific, so guide the
              user to pick their country + carrier for the correct instructions. */}
          {family === "gsm" && !isAustralia && (
            <p className="mt-3 flex gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <span>
                Forwarding codes vary by country and carrier. Select your country and carrier to view
                the correct instructions.
              </span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** The "Turn on" code, rendered with the AI number as a distinct highlighted
 *  token so it's obvious which digits the user supplies vs the fixed carrier code.
 *  Copyable (full dialable string) once the AI number is known. */
function ActivateCode({ row, dest, hasNumber }: { row: GsmCodeRow; dest: string; hasNumber: boolean }) {
  if (!row.activate) return <span className="text-muted-foreground">—</span>;
  const { prefix, suffix } = row.activate;
  const inner = (
    <>
      <span>{prefix}</span>
      <span
        className={cn(
          "mx-0.5 rounded px-1 py-0.5 font-semibold text-primary",
          hasNumber ? "bg-primary/15" : "bg-primary/10 italic",
        )}
        title="Your AI number goes here"
      >
        {hasNumber ? dest : "your AI number"}
      </span>
      <span>{suffix}</span>
    </>
  );
  // Nothing dialable to copy until the AI number exists — show the shape only.
  if (!hasNumber) {
    return (
      <span className="inline-flex max-w-full items-center rounded-md border border-dashed border-border bg-muted/30 px-2 py-1 font-mono text-xs font-semibold text-foreground">
        {inner}
      </span>
    );
  }
  return (
    <CopyCode value={activateCode(row, dest)!}>
      <span className="inline-flex items-center">{inner}</span>
    </CopyCode>
  );
}

/** A copy-on-click mono code chip. Copies `value`; renders `children` (or `value`). */
function CopyCode({ value, children }: { value: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success("Code copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy — long-press to copy the code");
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      title="Copy code"
      aria-label={`Copy code ${value}`}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-xs font-semibold text-foreground transition-colors hover:border-primary/40 hover:bg-primary-tint"
    >
      <span className="truncate">{children ?? value}</span>
      {copied ? (
        <Check className="size-3 shrink-0 text-success" />
      ) : (
        <Copy className="size-3 shrink-0 text-muted-foreground" />
      )}
    </button>
  );
}

/** Official carrier call-forwarding guides for the selected country, when we have
 *  curated links for it. Lets a user follow their own carrier's exact steps. */
function CarrierGuides({ iso, countryName }: { iso: string; countryName: string }) {
  const links = carrierDocLinks(iso);
  if (links.length === 0) return null;
  return (
    <div className="animate-rise flex gap-3 rounded-[var(--radius-card)] border border-border bg-card p-4 shadow-[var(--shadow-soft)]">
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary-tint text-primary">
        <BookOpen className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-foreground">
          Official carrier guides{countryName ? ` — ${countryName}` : ""}
        </p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          If a forwarding code doesn't work, check your carrier's official guide below, as codes may
          occasionally change:
        </p>
        <div className="mt-2.5 flex flex-wrap gap-2">
          {links.map((l) => (
            <a
              key={l.url}
              href={l.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:border-primary/40 hover:bg-primary-tint"
            >
              {l.label}
              <ExternalLink className="size-3.5" />
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The can't-miss caveat rendered above a tab's content — a bold amber alert
 *  with a soft pulse, so a user acts on it before working through the codes. */
function WarningAlert({ warning }: { warning: GuideWarning }) {
  return (
    <div className="animate-rise flex gap-3 rounded-[var(--radius-card)] border-2 border-warning/50 bg-warning-tint p-4 shadow-[var(--shadow-soft)]">
      <span className="relative flex size-9 shrink-0 items-center justify-center rounded-xl bg-warning text-white shadow-sm">
        <span className="absolute inline-flex size-9 animate-ping rounded-xl bg-warning/40" />
        <AlertTriangle className="relative size-5" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-bold text-foreground">{warning.title}</p>
        <p className="mt-1 text-xs leading-relaxed text-foreground/80">{warning.body}</p>
        <ol className="mt-2 space-y-1.5">
          {warning.steps.map((s, i) => (
            <li key={i} className="flex gap-2 text-xs text-foreground">
              <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-warning/20 text-[10px] font-bold text-warning">
                {i + 1}
              </span>
              <span className="leading-relaxed">{s}</span>
            </li>
          ))}
        </ol>
        {warning.tip && (
          <p className="mt-2.5 flex gap-1.5 text-xs font-medium text-foreground">
            <Check className="mt-0.5 size-3.5 shrink-0 text-success" />
            <span className="leading-relaxed">{warning.tip}</span>
          </p>
        )}
      </div>
    </div>
  );
}

/** "Verify your setup" — the same test-your-forwarding reminder under every flow. */
function VerifySetupCard() {
  return (
    <div className="animate-rise flex items-start gap-3 rounded-xl border border-success/30 bg-success-tint p-4">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-success text-white shadow-sm">
        <PhoneCall className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-foreground">Verify your setup</p>
        <ol className="mt-1 space-y-0.5 text-xs leading-relaxed text-muted-foreground">
          <li>1. Call your own phone number.</li>
          <li>2. Confirm the call reaches your AI receptionist.</li>
          <li>
            3. If it doesn't, check the troubleshooting guide below or verify your carrier settings.
          </li>
        </ol>
      </div>
    </div>
  );
}

/** "Info can change" disclaimer shown at the bottom of every tab. `carrier` names
 *  the provider to double-check with (the selected landline carrier); otherwise a
 *  generic "your carrier". */
function CarrierDisclaimer({ carrier }: { carrier?: string }) {
  return (
    <div className="animate-attention-amber flex items-start gap-3 rounded-xl border border-warning/45 bg-warning-tint p-3.5">
      {/* Pinging ring behind the icon pulls the eye to the note. */}
      <span className="relative flex size-8 shrink-0 items-center justify-center rounded-lg bg-warning text-white shadow-sm">
        <span className="absolute inline-flex size-8 animate-ping rounded-lg bg-warning/40 motion-reduce:hidden" />
        <Info className="relative size-4" />
      </span>
      <p className="text-sm leading-relaxed text-foreground/85">
        <span className="font-bold text-foreground">Heads up — </span>
        carrier steps and codes can change and may not be up to date. If something doesn't work,
        please verify with{" "}
        <span className="font-semibold text-foreground">{carrier?.trim() || "your carrier"}</span>.
      </p>
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success("Number copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy — long-press to copy the number");
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-primary/40 bg-card px-3 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary hover:text-primary-foreground"
      aria-label="Copy AI number"
    >
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      {copied ? "Copied" : "Copy number"}
    </button>
  );
}
