import { Fragment, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Check,
  Globe,
  Info,
  Loader2,
  LogIn,
  PhoneCall,
  Sparkles,
  Volume2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { BrandLogo } from "@/components/branding/BrandLogo";
import { Wordmark } from "@/components/branding/Wordmark";
import { HowItWorksDialog } from "@/components/marketing/HowItWorksDialog";
import { QuickControls } from "@/components/layout/QuickControls";
import { useOnboardingStore } from "@/stores/useOnboardingStore";
import { LANDING_VOICES, providerForVoiceId } from "@/data/voices";
import { speak, stopSpeaking } from "@/lib/speech";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { trackEvent } from "@/lib/analytics";
import { toast } from "sonner";

/** Per-voice accent colors, keyed by the LANDING_VOICES ElevenLabs voice_ids. */
const VOICE_ACCENT: Record<string, string> = {
  XrExE9yKIg1WjnnlVkGX: "#2C76ED", // Emma
  FGY2WhTYpPnrIDTdsKH5: "#EC4899", // Olivia
  IKne3meq5aSn9XLyUdCD: "#0EA5E9", // Jack
  JBFqnCBsd6RMkjVDRZzb: "#7C5CFC", // James
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const PLACEHOLDER_HOSTS = new Set([
  "example.com", "example.org", "example.net", "test.com", "test.org",
  "yourwebsite.com", "website.com", "mywebsite.com", "domain.com", "site.com",
  "localhost",
]);

/** True only for a well-formed public domain (rejects plain text and obvious placeholders). */
function isValidWebsite(raw: string): boolean {
  const v = raw.trim();
  if (!v || /\s/.test(v)) return false;
  let host: string;
  try {
    host = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`).hostname;
  } catch {
    return false;
  }
  if (!/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(host)) return false;
  return !PLACEHOLDER_HOSTS.has(host.toLowerCase().replace(/^www\./, ""));
}

/** Staggered entrance — pairs with the shared .animate-rise keyframes. */
const rise = (ms: number) => ({ animationDelay: `${ms}ms` });

/** Headline lead words for the Focus Cascade reveal; the gradient payoff
 *  phrase animates separately as a single unit. */
const HEADLINE_WORDS: ReadonlyArray<{ text: string; delay: number }> = [
  { text: "Turn", delay: 90 },
  { text: "missed", delay: 160 },
  { text: "calls", delay: 230 },
  { text: "into", delay: 300 },
];

/** Phrases the gradient tail of the headline cycles through. Keep the first
 *  entry as the canonical copy — it's what screen readers announce and what
 *  prefers-reduced-motion users see. */
const HERO_PHRASES = [
  "instant revenue.",
  "captured leads.",
  "happy customers.",
];

/** Cycles `index` through [0, count) every `holdMs`, exposing the previous
 *  index so the outgoing phrase can animate away. Never starts under
 *  prefers-reduced-motion and pauses while the tab is hidden. */
function useWordCycle(count: number, holdMs = 3400) {
  const [cycle, setCycle] = useState({ index: 0, prev: -1 });
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => {
      if (document.hidden) return; // don't churn in background tabs
      setCycle((c) => ({ index: (c.index + 1) % count, prev: c.index }));
    }, holdMs);
    return () => window.clearInterval(id);
  }, [count, holdMs]);
  return cycle;
}

/** Trust line under the form — reassurance only, not a content section. */
const TRUST_ITEMS = ["Live in minutes", "Cancel anytime"];

export default function LandingPage() {
  const navigate = useNavigate();
  const setUrl = useOnboardingStore((s) => s.setUrl);
  const reset = useOnboardingStore((s) => s.reset);
  const skipWebsite = useOnboardingStore((s) => s.skipWebsite);
  const voiceId = useOnboardingStore((s) => s.voiceId);
  const setVoiceId = useOnboardingStore((s) => s.setVoiceId);

  const [url, setLocalUrl] = useState("");
  const [howOpen, setHowOpen] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const spotRef = useRef<HTMLDivElement>(null);
  const { index: wordIndex, prev: wordPrev } = useWordCycle(HERO_PHRASES.length);

  // Cursor spotlight: a soft pool of light trails the pointer across the
  // canvas. Desktop pointers only — on touch it rests at its default spot
  // behind the stage. Writes the style directly (no re-render per mousemove);
  // the CSS transition supplies the damped "chase".
  useEffect(() => {
    if (!window.matchMedia("(pointer: fine)").matches) return;
    let raf = 0;
    const onMove = (e: MouseEvent) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        spotRef.current?.style.setProperty(
          "transform",
          `translate3d(${e.clientX}px, ${e.clientY}px, 0) translate(-50%, -50%)`,
        );
      });
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => {
      window.removeEventListener("mousemove", onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  useEffect(() => () => stopSpeaking(), []);

  function noWebsite() {
    stopSpeaking();
    const keepVoice = voiceId;
    reset();
    setVoiceId(keepVoice);
    skipWebsite();
    navigate("/onboarding");
  }

  // Triggered by the button click and by Enter in the URL field — NOT a native
  // form submit, so GTM's built-in form-submission listener never fires
  // `gtm.formSubmit`. Only our own `generate_ai_receptionist` event goes out.
  async function buildAgent() {
    if (checking) return; // ignore rapid double-clicks while a check is in flight

    const v = url.trim();
    setChecking(true);
    // One toast id so repeated submits update in place instead of stacking up.
    const errId = "landing-url";
    try {
      if (!v) {
        toast.error("Please enter your website URL", { id: errId });
        await delay(500); // brief loader so the button can't be machine-gunned
        return;
      }
      if (!isValidWebsite(v)) {
        toast.error("Hmm, that doesn't look like a website. Try something like yourbusiness.com", { id: errId });
        await delay(500);
        return;
      }

      const { reachable } = await api.onboard.validate(v);
      if (!reachable) {
        toast.error("We couldn't reach that website. Check the address and try again.", { id: errId });
        return;
      }
      // Marketing conversion signal — a UNIQUE event (not GTM's generic
      // gtm.formSubmit) so this can be tracked on its own in GTM / GA4 / Google
      // Ads. Fired only here, on the success path: the URL is non-blank, a valid
      // website, AND reachable, and we're actually generating the receptionist —
      // never on a blank or rejected submission.
      trackEvent("generate_ai_receptionist", { website_url: v });
      stopSpeaking();
      const keepVoice = voiceId;
      reset();
      setVoiceId(keepVoice);
      setUrl(v);
      navigate("/onboarding");
    } catch {
      toast.error("Couldn't verify that website. Please try again.", { id: errId });
    } finally {
      setChecking(false);
    }
  }

  function pickVoice(id: string) {
    setVoiceId(id);
    stopSpeaking();
    const v = LANDING_VOICES.find((x) => x.id === id);
    if (!v) return;
    setPlayingId(id);
    // Pass the raw id — LANDING_VOICES are ElevenLabs voice_ids, and squeezing
    // them through deepgramVoiceFor() collapsed every sample to the default
    // Deepgram voice. providerForVoiceId picks the right engine per id.
    speak(`Hi, I'm ${v.name}, your AI receptionist. I'll answer every call and book your jobs.`, {
      voiceId: id,
      provider: providerForVoiceId(id),
      onEnd: () => setPlayingId((p) => (p === id ? null : p)),
    });
  }

  return (
    <div className="relative flex min-h-screen flex-col overflow-x-clip bg-background lg:h-screen lg:overflow-hidden">
      {/* Header */}
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
            <Button asChild className="shadow-md transition-shadow hover:shadow-lg">
              <Link to="/login">
                <LogIn className="size-4" /> Sign In
              </Link>
            </Button>
          </div>
        </div>
      </header>

      {/* Hero — single centered column, the URL form is the sole focus */}
      {/* Backdrop: flowing sound waves (the product's voice, humming across
          the canvas) + a cursor spotlight that trails the pointer. Both
          respond while a voice sample plays. Reduced-motion safe. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <svg
          className={cn(
            "absolute inset-x-0 top-[54%] h-[72%] w-full -translate-y-1/2 [mask-image:linear-gradient(90deg,transparent,black_10%,black_90%,transparent)]",
            playingId && "lp-waves-active",
          )}
          viewBox="0 0 1440 600"
          preserveAspectRatio="none"
          fill="none"
        >
          <g className="lp-wave lp-wave-glow">
            <path d="M0 300 C 240 210, 480 390, 720 300 C 960 210, 1200 390, 1440 300" stroke="hsl(217 84% 55% / 0.30)" strokeWidth="2" pathLength="1" />
            <path d="M0 300 C 240 210, 480 390, 720 300 C 960 210, 1200 390, 1440 300" stroke="hsl(217 84% 55% / 0.30)" strokeWidth="2" pathLength="1" transform="translate(1440 0)" />
            <circle r="4" fill="hsl(217 84% 55% / 0.55)">
              <animateMotion dur="16s" repeatCount="indefinite" path="M0 300 C 240 210, 480 390, 720 300 C 960 210, 1200 390, 1440 300" />
            </circle>
            <circle r="2.5" fill="hsl(217 84% 55% / 0.4)">
              <animateMotion dur="16s" begin="-8s" repeatCount="indefinite" path="M0 300 C 240 210, 480 390, 720 300 C 960 210, 1200 390, 1440 300" />
            </circle>
          </g>
          <g className="lp-wave lp-wave-2">
            <path d="M0 345 C 240 440, 480 250, 720 345 C 960 440, 1200 250, 1440 345" stroke="hsl(217 84% 55% / 0.20)" strokeWidth="2" pathLength="1" />
            <path d="M0 345 C 240 440, 480 250, 720 345 C 960 440, 1200 250, 1440 345" stroke="hsl(217 84% 55% / 0.20)" strokeWidth="2" pathLength="1" transform="translate(1440 0)" />
            <circle r="3" fill="hsl(217 84% 55% / 0.35)">
              <animateMotion dur="22s" begin="-5s" repeatCount="indefinite" path="M0 345 C 240 440, 480 250, 720 345 C 960 440, 1200 250, 1440 345" />
            </circle>
          </g>
          <g className="lp-wave lp-wave-3">
            <path d="M0 255 C 240 195, 480 315, 720 255 C 960 195, 1200 315, 1440 255" stroke="hsl(217 84% 55% / 0.13)" strokeWidth="1.5" pathLength="1" />
            <path d="M0 255 C 240 195, 480 315, 720 255 C 960 195, 1200 315, 1440 255" stroke="hsl(217 84% 55% / 0.13)" strokeWidth="1.5" pathLength="1" transform="translate(1440 0)" />
            <circle r="2.5" fill="hsl(217 84% 55% / 0.3)">
              <animateMotion dur="26s" begin="-13s" repeatCount="indefinite" path="M0 255 C 240 195, 480 315, 720 255 C 960 195, 1200 315, 1440 255" />
            </circle>
          </g>
        </svg>
        <div
          ref={spotRef}
          className={cn(
            "lp-spot absolute left-0 top-0 size-[54rem] rounded-full transition-transform duration-300 ease-out will-change-transform",
            playingId && "lp-spot-active",
          )}
          style={{ transform: "translate3d(50vw, 44vh, 0) translate(-50%, -50%)" }}
        />
      </div>

      <main className="relative z-10 mx-auto flex w-full max-w-[1400px] flex-1 px-5 sm:px-8 lg:min-h-0">
        <div className="flex w-full">
          <div className="lp-hero grid w-full items-center pb-14 pt-10 sm:pt-14 lg:h-full lg:py-4">
          {/* ---------------- The ask ---------------- */}
          <section className="lp-copy mx-auto w-full max-w-xl text-center lg:max-w-[620px]">
            <span
              className="animate-rise inline-flex items-center gap-2 rounded-full border border-primary/25 bg-card/80 px-4 py-1.5 text-xs font-semibold text-primary shadow-sm backdrop-blur-sm"
              style={rise(0)}
            >
              <span className="relative flex size-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:animate-none" />
                <span className="relative inline-flex size-2 rounded-full bg-success" />
              </span>
              AI receptionist · live in minutes
            </span>

            <h1
              aria-label="Turn missed calls into instant revenue."
              className="mt-6 text-[2.6rem] font-bold leading-[1.06] tracking-tight sm:text-6xl lg:text-[3.4rem] lg:leading-[1.04] xl:text-[4rem] 2xl:text-[4.35rem]"
            >
              <span aria-hidden="true">
                <span className="block text-balance">
                  {HEADLINE_WORDS.map((w) => (
                    <Fragment key={w.text}>
                      <span className="hw-word" style={{ animationDelay: `${w.delay}ms` }}>
                        {w.text}
                      </span>{" "}
                    </Fragment>
                  ))}
                </span>
                {/* Rotating gradient phrase — grid-stacked so the line never
                    changes height; hw-payoff gives it the initial blur-reveal.
                    Motion stays on the wrapper, the gradient (bg-clip:text)
                    stays on the inner span — never merge the two. */}
                <span className="word-cycle hw-payoff" style={{ animationDelay: "420ms" }}>
                  {HERO_PHRASES.map((phrase, i) => (
                    <span
                      key={phrase}
                      className={cn(
                        "word-cycle-item",
                        i === wordIndex && wordPrev !== -1 && "word-cycle-in",
                        i === wordPrev && "word-cycle-out",
                      )}
                      style={i === 0 && wordPrev === -1 ? { opacity: 1 } : undefined}
                    >
                      <span className="animate-gradient bg-gradient-to-r from-primary via-[#22D3EE] to-[#7C5CFC] bg-clip-text text-transparent">
                        {phrase}
                      </span>
                    </span>
                  ))}
                </span>
              </span>
            </h1>

            <p
              className="animate-rise mx-auto mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground lg:max-w-[34rem]"
              style={rise(420)}
            >
              Capture every lead with a human-like AI receptionist.{" "}
              <span className="font-semibold text-primary">Enter your website URL</span> to try a
              demo instantly.
            </p>

            {/* URL form — the #1 element on the page: chromatic halo + glass card,
                full-width banner CTA */}
            <div className="animate-rise group relative mt-9" style={rise(520)}>
              {/* Decorative glow — must not catch clicks: -inset-8 extends it over
                  the buttons below (opacity-0 still hit-tests), which was swallowing
                  clicks on "How it works" / "I don't have a website". */}
              <div
                aria-hidden
                className="pointer-events-none absolute -inset-8 rounded-[36px] bg-primary/15 opacity-0 blur-2xl transition-opacity duration-500 group-focus-within:opacity-70"
              />
              <div
                aria-hidden
                className="pointer-events-none absolute -inset-[2px] rounded-[22px] bg-primary/30 opacity-60 blur-[3px] transition-opacity duration-300 group-focus-within:opacity-100"
              />
              <div
                className="card-glass relative rounded-[20px] border border-border p-3 shadow-[var(--shadow-panel)] transition-shadow focus-within:shadow-xl sm:p-3.5"
              >
                <div className="flex items-center gap-2.5 rounded-[14px] border border-border bg-background px-4 transition-colors focus-within:border-primary/60">
                  <Globe className="size-4 shrink-0 text-muted-foreground" />
                  <input
                    ref={urlInputRef}
                    value={url}
                    onChange={(e) => setLocalUrl(e.target.value)}
                    onKeyDown={(e) => {
                      // Enter still triggers generation — but as a click, not a
                      // native form submit, so no gtm.formSubmit fires.
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void buildAgent();
                      }
                    }}
                    placeholder="Enter your website URL"
                    className="h-[52px] w-full bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
                  />
                </div>
                <Button
                  type="button"
                  onClick={() => void buildAgent()}
                  size="lg"
                  disabled={checking}
                  className="group relative mt-2.5 h-[52px] w-full justify-center overflow-visible text-[15px] font-semibold shadow-lg shadow-primary/25 transition-all hover:shadow-xl hover:shadow-primary/35"
                >
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]"
                  >
                    <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent group-hover:animate-[shimmer_0.9s_ease-out]" />
                  </span>
                  {checking ? (
                    <>
                      <Loader2 className="size-4 animate-spin" /> Checking your website…
                    </>
                  ) : (
                    <>
                      <Sparkles className="size-4" /> Generate your AI receptionist
                    </>
                  )}
                  <span className="absolute -right-2 -top-2 rounded-full bg-success px-1.5 py-0.5 text-[10px] font-bold text-white shadow-sm">
                    FREE
                  </span>
                </Button>
              </div>
            </div>

            {/* Secondary paths */}
            <div
              className="animate-rise mt-5 flex items-center justify-center gap-3 text-sm"
              style={rise(600)}
            >
              <button
                type="button"
                onClick={noWebsite}
                className="font-medium text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-primary hover:decoration-primary"
              >
                I don't have a website
              </button>
              <span aria-hidden className="size-1 rounded-full bg-border" />
              <button
                type="button"
                onClick={() => setHowOpen(true)}
                className="inline-flex items-center gap-1.5 font-medium text-primary transition-colors hover:text-primary/80"
              >
                <Info className="size-4" /> How it works
              </button>
            </div>

            {/* Select your voice — tap a chip to hear a live sample. Rendered as a
                highlighted panel (tinted + glowing border + pulsing badge) so the
                picker reads as the hero's second step instead of fading into the
                background below the CTA. */}
            <div
              className="animate-rise mt-9 rounded-3xl border border-primary/25 bg-primary/[0.04] p-4 sm:p-5"
              style={rise(660)}
            >
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <p className="inline-flex items-center gap-2 rounded-full bg-primary px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-white shadow-sm">
                  <span className="relative flex size-2">
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-white/80" />
                    <span className="relative inline-flex size-2 rounded-full bg-white" />
                  </span>
                  Select your voice
                </p>
                <p className="inline-flex items-center gap-1.5 text-xs font-medium text-primary">
                  <Volume2 className="size-3.5" /> Tap a voice to hear a live sample.
                </p>
              </div>
              <div className="mt-3.5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                {LANDING_VOICES.map((v, i) => {
                  const selected = voiceId === v.id;
                  const playing = playingId === v.id;
                  const accent = VOICE_ACCENT[v.id] ?? "#2C76ED";
                  return (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => pickVoice(v.id)}
                      title={`Hear ${v.name}`}
                      className={cn(
                        "card-glass lift animate-rise group relative flex items-center gap-2.5 overflow-hidden rounded-2xl border p-2.5 text-left",
                        selected ? "border-primary/60 ring-1 ring-primary/25" : "border-border",
                      )}
                      style={rise(700 + i * 60)}
                    >
                      <span
                        className="relative grid size-9 shrink-0 place-items-center rounded-full text-[13px] font-bold text-white transition-transform duration-300 group-hover:scale-105"
                        style={{
                          background: `linear-gradient(135deg, ${accent}, ${accent}99)`,
                          boxShadow: selected
                            ? `0 0 0 2px ${accent}40, 0 8px 18px -8px ${accent}88`
                            : `0 8px 18px -10px ${accent}77`,
                        }}
                      >
                        {playing ? (
                          <span className="flex h-3.5 items-center gap-[2px]">
                            {[9, 13, 7, 11].map((h, bi) => (
                              <span
                                key={bi}
                                className="eq-bar w-[2px] rounded-full bg-white"
                                style={{ height: h, animationDelay: `${bi * 140}ms` }}
                              />
                            ))}
                          </span>
                        ) : (
                          v.name.charAt(0)
                        )}
                        {selected && !playing && (
                          <span className="absolute -bottom-1 -right-1 grid size-4 place-items-center rounded-full border-2 border-card bg-success text-white">
                            <Check className="size-2.5" />
                          </span>
                        )}
                        {playing && (
                          <span className="absolute -bottom-1 -right-1 grid size-4 place-items-center rounded-full border-2 border-card bg-primary text-white">
                            <Volume2 className="size-2.5" />
                          </span>
                        )}
                      </span>
                      <span className="min-w-0 leading-tight">
                        <span
                          className={cn(
                            "block truncate text-[13px] font-semibold",
                            selected ? "text-foreground" : "text-foreground/85",
                          )}
                        >
                          {v.name}
                        </span>
                        <span className="block truncate text-[11px] text-muted-foreground">{v.region}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Trust line */}
            <ul
              className="animate-rise mt-9 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 border-t border-border/60 pt-5 text-[13px] font-medium text-muted-foreground"
              style={rise(940)}
            >
              {TRUST_ITEMS.map((t) => (
                <li key={t} className="inline-flex items-center gap-1.5">
                  <Check className="size-3.5 text-success" /> {t}
                </li>
              ))}
            </ul>
          </section>

          </div>
        </div>
      </main>

      <HowItWorksDialog open={howOpen} onOpenChange={setHowOpen} />
    </div>
  );
}
