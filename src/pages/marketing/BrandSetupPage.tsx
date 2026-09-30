import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Navigate } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  Check,
  CheckCircle2,
  ClipboardCheck,
  CreditCard,
  Globe,
  Loader2,
  LogIn,
  Mail,
  Paintbrush,
  Palette,
  PhoneCall,
  Send,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { PhoneInput } from "@/components/ui/phone-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BrandLogo } from "@/components/branding/BrandLogo";
import { Wordmark } from "@/components/branding/Wordmark";
import { QuickControls } from "@/components/layout/QuickControls";
import { useBrandingStore } from "@/stores/useBrandingStore";
import { api, ApiError, type BrandAddon, type BrandPlan, type BrandThemeCatalog } from "@/lib/api";
import { formatMoney } from "@/lib/currency";
import { stripePromise } from "@/lib/stripe";
import { BrandPlanPicker } from "@/components/brand/BrandPlanPicker";
import { BrandCardForm } from "@/components/billing/BrandCardForm";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  BrandMark,
  CatalogSkeleton,
  ColoursChoice,
  LogosChoice,
  PUBLIC_LOGO_ACCEPT,
  TypographyPicker,
  useCatalogFonts,
  useObjectUrl,
  type LogoSlot,
} from "@/components/brand/BrandLookPickers";
import { COUNTRIES, guessCountry } from "@/data/countries";
import { cn } from "@/lib/utils";

// "Set up your brand": a prospective brand files its basics and its look (palette, typeface, logos).
// Nothing is created here — a super admin completes the setup (settings, permissions and the plans it
// sells, with the look pre-filled) from the Requested tab on Brands.

const ABOUT_MAX = 160;

// Same subdomain rules as the server, so the field self-corrects as it's typed.
function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Strip what people paste into a domain field — a scheme, a path, a stray
 *  "www." — down to the bare hostname. Same cleanup as the super admin's form. */
function cleanDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "")
    .replace(/\s+/g, "");
}

const STEPS = [
  { title: "Your brand", blurb: "Name and address", icon: Building2 },
  { title: "Look & logo", blurb: "Colours, font, logos", icon: Paintbrush },
  { title: "About you", blurb: "Your admin account", icon: UserRound },
  { title: "Plan & payment", blurb: "What you'll pay", icon: CreditCard },
  { title: "Review", blurb: "Check and send", icon: ClipboardCheck },
] as const;
const LOOK_STEP = 1;
const ABOUT_STEP = 2;
const PLAN_STEP = 3;
const REVIEW_STEP = 4;

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const FAVICON_TYPES = new Set([...LOGO_TYPES, "image/x-icon", "image/vnd.microsoft.icon"]);

const NEXT_STEPS = [
  { icon: Send, text: "You send us the basics — takes about two minutes." },
  { icon: Palette, text: "Our team reviews your look and sets up your plans and permissions." },
  { icon: Mail, text: "We email you when it's live. Sign in with the password you choose here." },
];

interface Draft {
  /** The brand plan chosen ("" = none yet). */
  brandPlanId: string;
  brandName: string;
  slug: string;
  tagline: string;
  customDomain: string;
  contactName: string;
  email: string;
  phone: string;
  country: string;
  password: string;
  notes: string;
  themePreset: string;
  primaryColor: string;
  accentColor: string;
  fontFamily: string;
}

type SlugState = { checking: boolean; available: boolean | null; reason: string };

export default function BrandSetupPage() {
  const onBrandDoor = useBrandingStore((s) => !!s.brand);

  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(() => ({
    brandName: "",
    slug: "",
    tagline: "",
    customDomain: "",
    contactName: "",
    email: "",
    phone: "",
    country: guessCountry().code.toUpperCase(),
    password: "",
    notes: "",
    brandPlanId: "",
    // The platform's defaults until the catalog says otherwise.
    themePreset: "ocean",
    primaryColor: "#2C76ED",
    accentColor: "#7C5CFC",
    fontFamily: "inter",
  }));
  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));
  const slugTouched = useRef(false);

  const [slugState, setSlugState] = useState<SlugState>({ checking: false, available: null, reason: "" });
  /** Bumped by "Retry" when the availability check itself failed. */
  const [slugRetry, setSlugRetry] = useState(0);
  const [suffix, setSuffix] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [catalog, setCatalog] = useState<(BrandThemeCatalog & { uploadsEnabled: boolean }) | null>(null);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [logos, setLogos] = useState<Record<LogoSlot, File | null>>({ logoLight: null, logoDark: null, favicon: null });
  const logoPreview = useObjectUrl(logos.logoLight);
  useCatalogFonts(catalog);
  const [done, setDone] = useState<{ brandName: string; email: string; host: string; charge: string } | null>(null);
  /** The brand plans on offer (what brands pay the platform) and whether a card can be saved here. */
  const [offer, setOffer] = useState<{ plans: BrandPlan[]; addons: BrandAddon[]; paymentsEnabled: boolean } | null>(null);
  const [offerFailed, setOfferFailed] = useState(false);
  /** The confirmed SetupIntent: the card is saved on Stripe, not charged. */
  const [savedCard, setSavedCard] = useState<{ setupIntentId: string } | null>(null);
  const [cardOpen, setCardOpen] = useState(false);

  // Debounced availability — the answer should land while they're still on the field.
  useEffect(() => {
    if (onBrandDoor) return;
    const slug = draft.slug;
    setSlugState({ checking: !!slug, available: null, reason: "" });
    const timer = setTimeout(
      async () => {
        try {
          const res = await api.brandRequests.checkSlug(slug || "yourbrand");
          setSuffix(res.suffix);
          if (slug) setSlugState({ checking: false, available: res.available, reason: res.reason });
        } catch {
          // Say so — a silently disabled Continue reads as a broken form.
          setSlugState({
            checking: false,
            available: null,
            reason: slug ? "We couldn't check this address just now." : "",
          });
        }
      },
      slug ? 350 : 0,
    );
    return () => clearTimeout(timer);
  }, [draft.slug, onBrandDoor, slugRetry]);

  // The palettes and typefaces on offer — the same catalog the platform's own brand editor uses.
  useEffect(() => {
    if (onBrandDoor) return;
    let active = true;
    api.brandRequests
      .catalog()
      .then((cat) => {
        if (!active) return;
        setCatalog(cat);
        const preset = cat.presets.find((p) => p.id === cat.defaults.preset);
        setDraft((d) => ({
          ...d,
          themePreset: cat.defaults.preset,
          fontFamily: cat.defaults.font,
          primaryColor: preset?.primary ?? d.primaryColor,
          accentColor: preset?.accent ?? d.accentColor,
        }));
      })
      .catch(() => active && setCatalogFailed(true));
    return () => {
      active = false;
    };
  }, [onBrandDoor]);

  useEffect(() => {
    if (onBrandDoor) return;
    let active = true;
    api.brandRequests
      .plans()
      .then((res) => {
        if (!active) return;
        setOffer(res);
        // Start on the default plan (else the first), so the usual choice is no click at all.
        const start = res.plans.find((p) => p.isDefault) ?? res.plans[0];
        if (start) setDraft((d) => (d.brandPlanId ? d : { ...d, brandPlanId: start.id }));
      })
      .catch(() => active && setOfferFailed(true));
    return () => {
      active = false;
    };
  }, [onBrandDoor]);

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim());
  const domainInvalid = !!draft.customDomain && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(draft.customDomain);
  const selectedPlan = offer?.plans.find((p) => p.id === draft.brandPlanId) ?? null;
  const planPrice = selectedPlan && selectedPlan.priceCents > 0 ? formatMoney(selectedPlan.priceCents, selectedPlan.currency) : "";
  // Cards need Stripe on both ends; without it the brand's admin pays at first sign-in instead.
  const cardNeeded = !!offer?.paymentsEnabled && !!stripePromise && !!planPrice;
  const stepValid = [
    draft.brandName.trim().length >= 2 && !!draft.slug && slugState.available === true && !domainInvalid,
    // The look always has a valid pick (the defaults), and logos are optional.
    true,
    draft.contactName.trim().length >= 2 && emailValid && draft.password.length >= 8,
    // A plan (when any is offered), and a saved card when the plan costs something and cards work here.
    offer
      ? (offer.plans.length === 0 || !!selectedPlan) && (!cardNeeded || !!savedCard)
      : offerFailed,
    true,
  ];

  if (onBrandDoor) return <Navigate to="/" replace />;

  const setName = (brandName: string) =>
    patch(slugTouched.current ? { brandName } : { brandName, slug: slugify(brandName) });

  /** Checked here as well as on the server, so a wrong file is caught before the last step. */
  function pickLogo(slot: LogoSlot, file: File | null) {
    if (file) {
      const types = slot === "favicon" ? FAVICON_TYPES : LOGO_TYPES;
      if (!types.has(file.type)) {
        toast.error(`Use a PNG, JPG, WebP or GIF${slot === "favicon" ? " (or ICO)" : ""} image.`);
        return;
      }
      if (file.size > MAX_LOGO_BYTES) {
        toast.error("That image is over 2 MB. Please use a smaller one.");
        return;
      }
    }
    setLogos((l) => ({ ...l, [slot]: file }));
  }

  const presetLabel = catalog?.presets.find((p) => p.id === draft.themePreset)?.label ?? draft.themePreset;
  const fontLabel = catalog?.fonts.find((f) => f.id === draft.fontFamily)?.label ?? draft.fontFamily;
  const logoCount = Object.values(logos).filter(Boolean).length;

  async function submit() {
    setSubmitting(true);
    try {
      const res = await api.brandRequests.create({
        brandName: draft.brandName,
        slug: draft.slug,
        tagline: draft.tagline,
        customDomain: draft.customDomain,
        contactName: draft.contactName,
        email: draft.email,
        phone: draft.phone,
        country: draft.country,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "",
        notes: draft.notes,
        password: draft.password,
        ...(selectedPlan ? { brandPlanId: selectedPlan.id } : {}),
        ...(savedCard ? { setupIntentId: savedCard.setupIntentId } : {}),
        // Only a look picked from the real catalog — if it never loaded, the team picks one at setup.
        ...(catalog
          ? {
              themePreset: draft.themePreset,
              primaryColor: draft.primaryColor,
              accentColor: draft.accentColor,
              fontFamily: draft.fontFamily,
            }
          : {}),
      }, {
        logoLight: logos.logoLight ?? undefined,
        logoDark: logos.logoDark ?? undefined,
        favicon: logos.favicon ?? undefined,
      });
      setDone({
        brandName: res.brandName,
        email: res.email,
        host: `${res.slug}${suffix}`,
        charge: savedCard && planPrice ? `${planPrice}/month` : "",
      });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't send your request. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function next() {
    if (!stepValid[step]) return;
    if (step < STEPS.length - 1) setStep(step + 1);
    else void submit();
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-40 border-b border-border/50 bg-background/70 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-[1400px] items-center justify-between px-5 py-3.5 sm:px-8">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <BrandLogo imgClassName="h-12 w-auto max-w-[230px] object-contain">
              <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
                <PhoneCall className="size-5" />
              </span>
              <span className="text-[17px]">
                <Wordmark />
              </span>
            </BrandLogo>
          </Link>
          <div className="flex items-center gap-2.5">
            <QuickControls />
            <Button asChild variant="outline">
              <Link to="/login">
                <LogIn className="size-4" /> Sign In
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-16 pt-8 sm:px-8 sm:pt-12">
        {done ? (
          <Card className="animate-rise mx-auto max-w-xl p-8 text-center sm:p-10">
            <span className="mx-auto grid size-14 place-items-center rounded-full bg-success/15 text-success">
              <CheckCircle2 className="size-7" />
            </span>
            <h1 className="mt-5 text-2xl font-semibold tracking-tight">Request received</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Thanks! Our team will set up <span className="font-medium text-foreground">{done.brandName}</span>
              &rsquo;s settings and permissions, then email{" "}
              <span className="font-medium text-foreground">{done.email}</span> when it&rsquo;s live at{" "}
              <span className="font-mono text-foreground">{done.host}</span>.
            </p>
            {done.charge && (
              <p className="mx-auto mt-3 flex max-w-sm items-center justify-center gap-1.5 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                <CreditCard className="size-3.5 shrink-0" />
                Your card is saved — {done.charge} starts when your brand goes live. Nothing has been charged.
              </p>
            )}
            <ol className="mx-auto mt-6 max-w-sm space-y-3 text-left">
              {NEXT_STEPS.map(({ icon: Icon, text }, i) => (
                <li key={text} className="flex items-start gap-3 text-sm">
                  <span
                    className={cn(
                      "grid size-7 shrink-0 place-items-center rounded-full",
                      i === 0 ? "bg-success text-white" : "bg-muted text-muted-foreground",
                    )}
                  >
                    {i === 0 ? <Check className="size-3.5" /> : <Icon className="size-3.5" />}
                  </span>
                  <span className="pt-1 text-muted-foreground">{text}</span>
                </li>
              ))}
            </ol>
            <Button asChild className="mt-8">
              <Link to="/">Back to home</Link>
            </Button>
          </Card>
        ) : (
          <div className="grid items-start gap-6 lg:grid-cols-[17rem_minmax(0,1fr)] lg:gap-10">
            {/* ---------------------------- Intro + progress --------------------------- */}
            <aside className="lg:sticky lg:top-24">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Your own brand</p>
              <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">Set up your brand</h1>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Sell AI receptionists under your own name, address and colours. Tell us the basics —
                we&rsquo;ll do the rest.
              </p>

              <ol className="mt-6 flex gap-2 lg:flex-col lg:gap-1">
                {STEPS.map(({ title, blurb, icon: Icon }, i) => {
                  const state = i < step ? "done" : i === step ? "current" : "todo";
                  return (
                    <li key={title} className="min-w-0 flex-1">
                      <button
                        type="button"
                        // Back is always open; forward only through steps already valid.
                        disabled={i > step && !stepValid.slice(0, i).every(Boolean)}
                        onClick={() => setStep(i)}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-xl p-2 text-left transition-colors lg:p-2.5",
                          state === "current" ? "bg-primary-tint-soft" : "hover:bg-muted/60",
                          "disabled:pointer-events-none",
                        )}
                      >
                        <span
                          className={cn(
                            "grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold",
                            state === "done" && "bg-success text-white",
                            state === "current" && "bg-primary text-primary-foreground",
                            state === "todo" && "border border-border bg-card text-muted-foreground",
                          )}
                        >
                          {state === "done" ? <Check className="size-4" /> : <Icon className="size-4" />}
                        </span>
                        <span className="hidden min-w-0 sm:block">
                          <span
                            className={cn(
                              "block truncate text-sm font-medium",
                              state === "todo" && "text-muted-foreground",
                            )}
                          >
                            {title}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">{blurb}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>

              <div className="mt-6 hidden rounded-2xl border border-border bg-card p-4 lg:block">
                <p className="flex items-center gap-2 text-sm font-semibold">
                  <ShieldCheck className="size-4 text-primary" /> What happens next
                </p>
                <ul className="mt-3 space-y-2.5">
                  {NEXT_STEPS.map(({ icon: Icon, text }) => (
                    <li key={text} className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                      <Icon className="mt-0.5 size-3.5 shrink-0 text-primary" />
                      {text}
                    </li>
                  ))}
                </ul>
              </div>
            </aside>

            {/* --------------------------------- Form --------------------------------- */}
            <Card className="p-5 sm:p-7">
              <p className="text-xs font-medium text-muted-foreground">
                Step {step + 1} of {STEPS.length}
              </p>
              <h2 className="mt-1 text-lg font-semibold">{STEPS[step].title}</h2>

              <form
                className="mt-5 space-y-5"
                onSubmit={(e) => {
                  e.preventDefault();
                  next();
                }}
              >
                {step === 0 && (
                  <>
                    <Field id="r-name" label="Brand name" required>
                      <Input
                        id="r-name"
                        value={draft.brandName}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Acme Voice"
                        maxLength={60}
                        autoFocus
                      />
                    </Field>

                    <Field id="r-slug" label="Brand address" required>
                      <div className="flex items-stretch">
                        <span className="hidden items-center rounded-l-xl border border-r-0 border-border bg-muted px-3 text-sm text-muted-foreground sm:inline-flex">
                          https://
                        </span>
                        <div className="relative min-w-0 flex-1">
                          <Input
                            id="r-slug"
                            value={draft.slug}
                            spellCheck={false}
                            onChange={(e) => {
                              slugTouched.current = true;
                              patch({ slug: slugify(e.target.value) });
                            }}
                            placeholder="acme"
                            className={cn("pr-9 font-mono sm:rounded-l-none sm:border-l-0", suffix && "rounded-r-none")}
                          />
                          <span className="absolute right-3 top-1/2 -translate-y-1/2">
                            {slugState.checking ? (
                              <Loader2 className="size-4 animate-spin text-muted-foreground" />
                            ) : slugState.available === true ? (
                              <Check className="size-4 text-success" />
                            ) : slugState.available === false ? (
                              <X className="size-4 text-danger" />
                            ) : null}
                          </span>
                        </div>
                        {suffix && (
                          <span className="inline-flex max-w-[45%] items-center truncate rounded-r-xl border border-l-0 border-border bg-muted px-3 font-mono text-sm text-muted-foreground">
                            {suffix}
                          </span>
                        )}
                      </div>
                      {slugState.available === false ? (
                        <p className="mt-1 text-xs text-danger">{slugState.reason}</p>
                      ) : slugState.reason ? (
                        <p className="mt-1 text-xs text-foreground">
                          {slugState.reason}{" "}
                          <button
                            type="button"
                            onClick={() => setSlugRetry((n) => n + 1)}
                            className="font-medium underline underline-offset-2"
                          >
                            Try again
                          </button>
                        </p>
                      ) : (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Where your customers will find you. It keeps working even once your own
                          domain is live.
                        </p>
                      )}
                    </Field>

                    <Field id="r-about" label="About your brand" optional>
                      <Textarea
                        id="r-about"
                        rows={3}
                        value={draft.tagline}
                        maxLength={ABOUT_MAX}
                        onChange={(e) => patch({ tagline: e.target.value })}
                        placeholder="Who you serve and what makes you different…"
                        className="resize-y"
                      />
                      <p className="mt-1 text-right text-xs text-muted-foreground">
                        {draft.tagline.length}/{ABOUT_MAX}
                      </p>
                    </Field>

                    <Field id="r-domain" label="Own domain" optional>
                      <div className="relative">
                        <Globe className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          id="r-domain"
                          value={draft.customDomain}
                          spellCheck={false}
                          onChange={(e) => patch({ customDomain: cleanDomain(e.target.value) })}
                          placeholder="app.acme.com"
                          className="pl-10 font-mono"
                          maxLength={253}
                        />
                      </div>
                      {domainInvalid ? (
                        <p className="mt-1 text-xs text-danger">
                          That doesn&rsquo;t look like a domain — use something like app.acme.com.
                        </p>
                      ) : (
                        <p className="mt-1 text-xs text-muted-foreground">
                          A domain you own that customers should use instead. Once your brand is set
                          up, we&rsquo;ll send you the DNS records to point it at us.
                        </p>
                      )}
                    </Field>
                  </>
                )}

                {step === LOOK_STEP && (
                  <>
                    <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/40 p-3">
                      <BrandMark
                        logoUrl={logoPreview}
                        name={draft.brandName}
                        primary={draft.primaryColor}
                        accent={draft.accentColor}
                        className="size-11 rounded-xl text-base"
                      />
                      <div className="min-w-0">
                        <p
                          className="truncate text-sm font-semibold"
                          style={{ fontFamily: catalog?.fonts.find((f) => f.id === draft.fontFamily)?.stack }}
                        >
                          {draft.brandName || "Your brand"}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          How your brand looks to its customers. Our team can fine-tune it later.
                        </p>
                      </div>
                    </div>

                    {/* Colours and logos each open their own dialog; the font and its live preview
                        stay on the page, where the colour choice shows up as soon as it's made. */}
                    <div className="grid gap-3 sm:grid-cols-2">
                      <ColoursChoice
                        presets={catalog?.presets ?? null}
                        value={draft.themePreset}
                        primary={draft.primaryColor}
                        accent={draft.accentColor}
                        brandName={draft.brandName}
                        logoUrl={logoPreview}
                        onPick={(p) => patch({ themePreset: p.id, primaryColor: p.primary, accentColor: p.accent })}
                        pendingLabel={catalogFailed ? "Unavailable right now" : "Loading…"}
                      />
                      <LogosChoice
                        files={logos}
                        onPick={pickLogo}
                        accept={PUBLIC_LOGO_ACCEPT}
                        lightHint="For light backgrounds"
                        unavailable={catalog && !catalog.uploadsEnabled ? "Collected during setup" : undefined}
                        description={
                          <>
                            All optional — anything you skip shows your brand&rsquo;s initial on your colours.
                            PNG, JPG, WebP or GIF up to 2 MB. Have an SVG? Send it to our team and they&rsquo;ll
                            add it during setup.
                          </>
                        }
                      />
                    </div>

                    {catalog ? (
                      <TypographyPicker
                        id="r-font"
                        fonts={catalog.fonts}
                        value={draft.fontFamily}
                        primary={draft.primaryColor}
                        accent={draft.accentColor}
                        onChange={(fontFamily) => patch({ fontFamily })}
                      />
                    ) : catalogFailed ? (
                      <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
                        We couldn&rsquo;t load the colour and font choices right now. Carry on — our team
                        will pick them with you during setup.
                      </p>
                    ) : (
                      <CatalogSkeleton />
                    )}
                  </>
                )}

                {step === ABOUT_STEP && (
                  <>
                    <div className="grid gap-5 sm:grid-cols-2">
                      <Field id="r-contact" label="Full name" required>
                        <Input
                          id="r-contact"
                          value={draft.contactName}
                          onChange={(e) => patch({ contactName: e.target.value })}
                          placeholder="Jordan Blake"
                          autoComplete="name"
                          maxLength={80}
                          autoFocus
                        />
                      </Field>
                      <Field id="r-email" label="Work email" required>
                        <Input
                          id="r-email"
                          type="email"
                          value={draft.email}
                          onChange={(e) => patch({ email: e.target.value })}
                          placeholder="jordan@acme.com"
                          autoComplete="email"
                          maxLength={160}
                        />
                      </Field>
                      <Field id="r-phone" label="Phone" optional>
                        <PhoneInput
                          id="r-phone"
                          value={draft.phone}
                          onChange={(phone) => patch({ phone })}
                          autoComplete="tel"
                        />
                      </Field>
                      <Field id="r-country" label="Country">
                        <Select value={draft.country} onValueChange={(country) => patch({ country })}>
                          <SelectTrigger id="r-country" className="h-10 rounded-xl">
                            <SelectValue placeholder="Select a country" />
                          </SelectTrigger>
                          <SelectContent>
                            {COUNTRIES.map((c) => (
                              <SelectItem key={c.code} value={c.code.toUpperCase()}>
                                {c.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                    </div>
                    <Field
                      id="r-password"
                      label="Choose a password"
                      required
                      hint="At least 8 characters. You'll sign in to your brand's admin panel with this email and password once it's live."
                    >
                      <PasswordInput
                        id="r-password"
                        autoComplete="new-password"
                        value={draft.password}
                        onChange={(e) => patch({ password: e.target.value })}
                        placeholder="At least 8 characters"
                      />
                    </Field>
                  </>
                )}

                {step === PLAN_STEP && (
                  <>
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      Pick the plan your brand runs on. Nothing is charged today — your first month is charged
                      when our team has set your brand up.
                    </p>

                    {offer === null ? (
                      offerFailed ? (
                        <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
                          We couldn&rsquo;t load the plans right now. Carry on — our team will go through them
                          with you.
                        </p>
                      ) : (
                        <CatalogSkeleton />
                      )
                    ) : offer.plans.length === 0 ? (
                      <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
                        Our team will go through the plans with you when they set up your brand.
                      </p>
                    ) : (
                      <BrandPlanPicker
                        plans={offer.plans}
                        addons={offer.addons}
                        value={draft.brandPlanId || null}
                        onChange={(id) => patch({ brandPlanId: id ?? "" })}
                        className="sm:grid-cols-2 xl:grid-cols-2"
                      />
                    )}

                    {cardNeeded && (
                      <div className="rounded-xl border border-border p-4">
                        <p className="flex items-center gap-2 text-sm font-medium">
                          <CreditCard className="size-4 text-muted-foreground" /> Payment
                        </p>
                        {savedCard ? (
                          <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                            <CheckCircle2 className="size-4 text-success" />
                            Card saved — {planPrice}/month starts when your brand goes live.
                            <button
                              type="button"
                              onClick={() => {
                                setSavedCard(null);
                                setCardOpen(true);
                              }}
                              className="text-xs font-medium text-primary hover:underline"
                            >
                              Use another card
                            </button>
                          </p>
                        ) : (
                          <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                            <p className="text-xs text-muted-foreground">
                              Saved securely with Stripe. If we can&rsquo;t set your brand up, it&rsquo;s removed and
                              never charged.
                            </p>
                            <Button type="button" onClick={() => setCardOpen(true)}>
                              <CreditCard className="size-4" /> Add card
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                    {!cardNeeded && selectedPlan && planPrice && offer && (
                      <p className="text-xs text-muted-foreground">
                        Card payments aren&rsquo;t available here right now — you&rsquo;ll pay from your admin panel
                        when your brand is live.
                      </p>
                    )}
                  </>
                )}

                {step === REVIEW_STEP && (
                  <>
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      Almost done. Check your details below — our team picks your plans and sets up
                      everything else when they review your request.
                    </p>

                    <Field id="r-notes" label="Anything else we should know?" optional>
                      <Textarea
                        id="r-notes"
                        rows={3}
                        value={draft.notes}
                        maxLength={1000}
                        onChange={(e) => patch({ notes: e.target.value })}
                        placeholder="Expected customers, pricing you have in mind, questions…"
                        className="resize-y"
                        autoFocus
                      />
                    </Field>

                    <div className="rounded-xl border border-border bg-muted/40 p-4 text-sm">
                      <p className="font-medium">Your request</p>
                      <dl className="mt-2 grid gap-x-4 gap-y-1.5 text-xs sm:grid-cols-[7rem_minmax(0,1fr)]">
                        <dt className="text-muted-foreground">Brand</dt>
                        <dd className="truncate">{draft.brandName}</dd>
                        <dt className="text-muted-foreground">Address</dt>
                        <dd className="truncate font-mono">
                          {draft.slug}
                          {suffix}
                        </dd>
                        {draft.customDomain && (
                          <>
                            <dt className="text-muted-foreground">Own domain</dt>
                            <dd className="truncate font-mono">{draft.customDomain}</dd>
                          </>
                        )}
                        {catalog && (
                          <>
                            <dt className="text-muted-foreground">Look</dt>
                            <dd className="flex min-w-0 items-center gap-1.5">
                              <span
                                aria-hidden
                                className="size-3 shrink-0 rounded-full"
                                style={{ background: draft.primaryColor }}
                              />
                              <span className="truncate">
                                {presetLabel} · {fontLabel}
                              </span>
                            </dd>
                          </>
                        )}
                        {selectedPlan && (
                          <>
                            <dt className="text-muted-foreground">Plan</dt>
                            <dd className="truncate">
                              {selectedPlan.name} · {planPrice ? `${planPrice}/month` : "Free"}
                            </dd>
                          </>
                        )}
                        {cardNeeded && (
                          <>
                            <dt className="text-muted-foreground">Payment</dt>
                            <dd>{savedCard ? "Card saved — charged when your brand is live" : "No card"}</dd>
                          </>
                        )}
                        <dt className="text-muted-foreground">Logos</dt>
                        <dd>{logoCount ? `${logoCount} uploaded` : "None — you can add them later"}</dd>
                        <dt className="text-muted-foreground">Admin</dt>
                        <dd className="truncate">
                          {draft.contactName} · {draft.email}
                        </dd>
                      </dl>
                    </div>
                  </>
                )}

                <div className="flex items-center justify-between gap-3 border-t border-border pt-5">
                  {step > 0 ? (
                    <Button type="button" variant="ghost" onClick={() => setStep(step - 1)} disabled={submitting}>
                      <ArrowLeft className="size-4" /> Back
                    </Button>
                  ) : (
                    <Button asChild type="button" variant="ghost">
                      <Link to="/">
                        <ArrowLeft className="size-4" /> Home
                      </Link>
                    </Button>
                  )}
                  <Button type="submit" disabled={!stepValid[step] || submitting} className="min-w-[9rem]">
                    {submitting ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : step === STEPS.length - 1 ? (
                      <Send className="size-4" />
                    ) : null}
                    {step === STEPS.length - 1 ? "Send request" : "Continue"}
                    {step < STEPS.length - 1 && <ArrowRight className="size-4" />}
                  </Button>
                </div>
              </form>
            </Card>
          </div>
        )}
      </main>

      <Dialog open={cardOpen} onOpenChange={setCardOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add your card</DialogTitle>
            <DialogDescription>
              {selectedPlan?.name} · {planPrice}/month. Nothing is charged today.
            </DialogDescription>
          </DialogHeader>
          {cardOpen && (
            <BrandCardForm
              submitLabel="Save card"
              note="Your first month is charged when our team completes your brand's setup. If we can't set it up, your card is removed."
              createIntent={() => api.brandRequests.setupIntent({ email: draft.email, name: draft.contactName })}
              onConfirmed={async (_paymentMethodId, setupIntentId) => {
                setSavedCard({ setupIntentId });
                setCardOpen(false);
                toast.success("Card saved");
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({
  id,
  label,
  required,
  optional,
  hint,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  optional?: boolean;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <Label htmlFor={id} className="text-sm font-medium">
        {label}
        {required && <span className="ml-1 text-danger">*</span>}
        {optional && <span className="ml-1 font-normal text-muted-foreground">(optional)</span>}
      </Label>
      <div className="mt-2">{children}</div>
      {hint && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}
