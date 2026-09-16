import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useAgentStore } from "@/stores/useAgentStore";
import { useProfileStore } from "@/stores/useProfileStore";
import { DEFAULT_AGENT_CONFIG } from "@/data/defaultAgentConfig";
import { toast } from "sonner";
import { uid, capitalize } from "@/lib/utils";
import { clampName } from "@/lib/limits";
import { autoGreeting } from "@/lib/compilePrompt";
import { api, ApiError } from "@/lib/api";

// Dedupes concurrent analyze calls — StrictMode double-mounts Step 1 in dev, which
// fired two /analyze requests and two error toasts.
let analyzeInFlight: Promise<void> | null = null;

export interface OnboardingData {
  url: string;
  businessName: string;
  businessDescription: string;
  /** Account owner's name. */
  fullName: string;
  email: string;
  /** Owner's personal mobile (call summaries / SMS). */
  mobile: string;
  /** Business/support number customers call — from the site or entered manually. */
  phone: string;
  address: string;
  services: string[];
  /** FAQs scraped from the website (Q&A) — seeded into the agent's Knowledge. */
  faqs: { question: string; answer: string }[];
  /** AI-suggested, business-specific call-handling rules — seeded into the agent's
   *  Scenario Handling (editable later in the AI Brain). */
  scenarios: { ifText: string; thenText: string }[];
  /** Opening hours scraped from the website — seeded into Rules → Business Hours.
   *  Empty when the site didn't state them, so the 9–5 default is used instead. */
  businessHours: string;
}

export const ONBOARDING_TOTAL_STEPS = 6;

interface OnboardingState {
  step: number; // 1..6
  data: OnboardingData;
  analyzed: boolean;
  /** Set once the account is created + verified — locks/skips the account + OTP steps. */
  accountCreated: boolean;
  markAccountCreated: () => void;
  /** Furthest step reached, so we can jump forward to the pending step. */
  furthestStep: number;
  /** Jump forward to the furthest (pending) step. */
  resumeForward: () => void;
  /** True when the user chose "I don't have a website" — skips analysis. */
  skippedWebsite: boolean;
  /** Skip the website/analysis steps and go straight to an empty business form. */
  skipWebsite: () => void;
  /** Return to the website chooser (undo a skip / change the URL). */
  editWebsite: () => void;
  /** Voice picked on the landing page ("Choose your voice"). */
  voiceId: string;
  setVoiceId: (id: string) => void;
  /** When true, the guided voice setup (Emma speaks, you type) is showing. */
  voiceActive: boolean;
  setVoiceActive: (active: boolean) => void;
  /** Account password — kept in memory across steps, never written to storage. */
  password: string;
  setPassword: (value: string) => void;
  setUrl: (url: string) => void;
  /** Analyze the website via the backend. On failure: leave fields empty + toast. */
  analyzeFromUrl: () => Promise<void>;
  updateData: (patch: Partial<OnboardingData>) => void;
  addService: (name: string) => void;
  removeService: (index: number) => void;
  next: () => void;
  back: () => void;
  goTo: (step: number) => void;
  /** Push the collected data into the live agent config + profile, and persist
   *  the seeded agent config to the DB so it survives the AI Brain's first load. */
  applyToAccount: () => Promise<void>;
  reset: () => void;
}

// Password stays out of localStorage; sessionStorage mirror survives a reload / going
// back a step, and clears itself when the tab closes.
const PW_KEY = "hello22_onboarding_pw";
const readPw = () => {
  try {
    return sessionStorage.getItem(PW_KEY) ?? "";
  } catch {
    return "";
  }
};
const writePw = (value: string) => {
  try {
    if (value) sessionStorage.setItem(PW_KEY, value);
    else sessionStorage.removeItem(PW_KEY);
  } catch {
    /* sessionStorage unavailable (private mode / SSR) — fall back to memory only */
  }
};

/** Persist the furthest onboarding step to the account (best-effort) so a
 *  returning user resumes here after logging back in. */
const syncProgress = (step: number) => {
  if (step < 5) return; // only the post-verification steps are resumable
  void api.profile.onboardingProgress({ step }).catch(() => {});
};

const EMPTY: OnboardingData = {
  url: "",
  businessName: "",
  businessDescription: "",
  fullName: "",
  email: "",
  mobile: "",
  phone: "",
  address: "",
  services: [],
  faqs: [],
  scenarios: [],
  businessHours: "",
};

export const useOnboardingStore = create<OnboardingState>()(
  persist(
    (set, get) => ({
      step: 1,
      data: EMPTY,
      analyzed: false,
      accountCreated: false,
      furthestStep: 1,
      skippedWebsite: false,
      voiceId: "EXAVITQu4vr4xnSDxMaL", // Sarah (ElevenLabs) — showcase default
      voiceActive: false,
      password: readPw(),

      markAccountCreated: () => set({ accountCreated: true }),
      resumeForward: () => set((s) => ({ step: s.furthestStep })),

      setPassword: (value) => {
        writePw(value);
        set({ password: value });
      },

      skipWebsite: () => set({ skippedWebsite: true, analyzed: true, step: 2 }),
      editWebsite: () => set((s) => ({ skippedWebsite: false, step: 1, data: { ...s.data, url: "" } })),

      setVoiceId: (id) => set({ voiceId: id }),
      setVoiceActive: (active) => set({ voiceActive: active }),

      setUrl: (url) => set((s) => ({ data: { ...s.data, url } })),

      analyzeFromUrl: async () => {
        // A call already running (e.g. StrictMode's second mount) shares it.
        if (analyzeInFlight) return analyzeInFlight;

        analyzeInFlight = (async () => {
          const url = get().data.url.trim();
          if (!url) {
            // No URL captured — nothing to analyze; leave the form empty for manual entry.
            set({ analyzed: true });
            return;
          }
          try {
            const r = await api.onboard.analyze(url);
            set((s) => ({
              analyzed: true,
              data: {
                ...s.data,
                businessName: r.businessName || s.data.businessName,
                businessDescription: r.description || s.data.businessDescription,
                phone: r.phone || s.data.phone,
                email: r.email || s.data.email,
                address: r.address || s.data.address,
                services: r.services.length ? r.services : s.data.services,
                faqs: r.faqs?.length ? r.faqs : s.data.faqs,
                scenarios: r.scenarios?.length ? r.scenarios : s.data.scenarios,
                businessHours: r.businessHours?.trim() ? r.businessHours.trim() : s.data.businessHours,
              },
            }));
          } catch (e) {
            // Bad/unreachable URL, or nothing could be read — DON'T fabricate.
            // Leave the business fields empty and surface a clear error.
            set({ analyzed: true });
            toast.error(
              e instanceof ApiError
                ? e.message
                : "We couldn't read that website. Please enter your business details manually.",
            );
          }
        })();

        try {
          await analyzeInFlight;
        } finally {
          analyzeInFlight = null;
        }
      },

      updateData: (patch) => set((s) => ({ data: { ...s.data, ...patch } })),

      addService: (name) => {
        const v = name.trim();
        if (!v) return;
        set((s) => ({ data: { ...s.data, services: [...s.data.services, v] } }));
      },

      removeService: (index) =>
        set((s) => ({
          data: { ...s.data, services: s.data.services.filter((_, i) => i !== index) },
        })),

      next: () => {
        const s = get();
        let target = s.step + 1;
        // Account (3) + OTP (4) are done once the account exists — skip over them.
        if (s.accountCreated) while (target < ONBOARDING_TOTAL_STEPS && (target === 3 || target === 4)) target += 1;
        target = Math.min(ONBOARDING_TOTAL_STEPS, target);
        const furthestStep = Math.max(s.furthestStep, target);
        set({ step: target, furthestStep });
        if (s.accountCreated) syncProgress(furthestStep);
      },
      back: () =>
        set((s) => {
          let target = s.step - 1;
          if (s.accountCreated) while (target > 1 && (target === 3 || target === 4)) target -= 1;
          return { step: Math.max(1, target) };
        }),
      goTo: (step) => {
        const s = get();
        const target = Math.max(1, Math.min(ONBOARDING_TOTAL_STEPS, step));
        const furthestStep = Math.max(s.furthestStep, target);
        set({ step: target, furthestStep });
        if (s.accountCreated) syncProgress(furthestStep);
      },

      applyToAccount: async () => {
        const { data } = get();
        // Reset first: the agent store is persisted, so a previous account in this browser
        // would leak its config into the new signup (a fresh account once came out named "Test12").
        useAgentStore.getState().reset();
        useAgentStore.getState().updateSection("identity", (prev) => {
          const business = data.businessName.trim();
          // Name the receptionist after the business only while the name is still the
          // untouched default — never clobber one the owner set.
          const untouched =
            !prev.assistantName?.trim() ||
            prev.assistantName.trim() === DEFAULT_AGENT_CONFIG.identity.assistantName;
          return {
            ...prev,
            // Clamp: a long scraped page title over the 40-char cap makes Vapi reject the
            // assistant (this path produced the "73/40").
            businessName: clampName(data.businessName),
            // From the CLAMPED name so the greeting matches what's stored.
            greetingMessage: autoGreeting(clampName(data.businessName)),
            // Voice is deliberately not seeded from the showcase — new agents start on the
            // default (Sarah); changing it is a paid-plan action in the AI Brain.
            ...(business && untouched
              ? { assistantName: clampName(`${business} Receptionist`) }
              : {}),
          };
        });
        // Seed knowledge: About + Contact as quick facts, Services as its own list.
        useAgentStore.getState().updateSection("knowledge", (prev) => {
          const reserved = new Set(["About", "Services", "Phone", "Email", "Address", "Website"]);
          const facts = prev.quickFacts.filter((f) => !reserved.has(f.key));
          if (data.businessDescription)
            facts.push({ id: uid("qf"), key: "About", value: data.businessDescription });
          if (data.phone) facts.push({ id: uid("qf"), key: "Phone", value: data.phone });
          if (data.email) facts.push({ id: uid("qf"), key: "Email", value: data.email });
          if (data.address) facts.push({ id: uid("qf"), key: "Address", value: data.address });
          // The website the owner onboarded with — goes into the master prompt
          // via Key Business Facts so the assistant can point callers to it.
          if (data.url.trim())
            facts.push({
              id: uid("qf"),
              key: "Website",
              value: data.url.trim().replace(/^https?:\/\//i, "").replace(/\/$/, ""),
            });
          // Services scraped/entered during onboarding seed the editable Services list.
          const services = data.services.map((s) => s.trim()).filter(Boolean);
          // Seed FAQs scraped from the website (skip any the user already added).
          const existingQ = new Set((prev.faqs ?? []).map((f) => f.question.trim().toLowerCase()));
          const seededFaqs = data.faqs
            .filter((f) => f.question.trim() && f.answer.trim() && !existingQ.has(f.question.trim().toLowerCase()))
            .slice(0, 3)
            .map((f) => ({ id: uid("faq"), question: f.question.trim(), answer: f.answer.trim() }));
          return {
            ...prev,
            quickFacts: facts,
            services: services.length ? services : (prev.services ?? []),
            faqs: [...(prev.faqs ?? []), ...seededFaqs],
          };
        });
        // Seed business-specific scenarios when the analyser returned any; editable later
        // in AI Brain → Rules.
        const seededScenarios = data.scenarios
          .filter((s) => s.ifText.trim() && s.thenText.trim())
          .slice(0, 3)
          .map((s) => ({ id: uid("sc"), ifText: capitalize(s.ifText.trim()), thenText: capitalize(s.thenText.trim()) }));
        // Business hours: use the site's stated hours when the analyser found them,
        // otherwise leave the config's 9–5 default in place.
        const seededHours = data.businessHours.trim();
        if (seededScenarios.length || seededHours) {
          useAgentStore.getState().updateSection("rules", (prev) => ({
            ...prev,
            ...(seededScenarios.length ? { scenarioHandling: seededScenarios } : {}),
            ...(seededHours ? { businessHours: seededHours } : {}),
          }));
        }
        // Seed the profile. `mobile` is the owner's personal number (call
        // summaries/SMS); `businessNumber` is the public support number callers ring.
        useProfileStore.getState().updateProfile({
          businessName: clampName(data.businessName),
          website: data.url ? data.url.replace(/^https?:\/\//i, "").replace(/\/$/, "") : "",
          ...(data.fullName ? { fullName: data.fullName } : {}),
          ...(data.mobile ? { mobile: data.mobile } : {}),
          ...(data.email ? { email: data.email } : {}),
          ...(data.phone ? { businessNumber: data.phone } : {}),
          ...(data.address ? { address: data.address } : {}),
        });
        // Persist now or the AI Brain's first hydrate overwrites the seeded services/FAQs
        // with defaults. Retry (a cold API often fails the first hit) and tell the user if it still fails.
        let persisted = false;
        for (let attempt = 0; attempt < 3 && !persisted; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));
          persisted = await api.agent
            .persist(useAgentStore.getState().config)
            .then(() => true)
            .catch(() => false);
        }
        if (!persisted) {
          toast.error("Couldn't save your setup to the server", {
            description:
              "Your services and FAQs weren't stored. Open the AI Brain and press Save Changes to keep them.",
            duration: 10000,
          });
        }
      },

      reset: () => {
        writePw("");
        set({
          step: 1,
          data: EMPTY,
          analyzed: false,
          accountCreated: false,
          furthestStep: 1,
          skippedWebsite: false,
          voiceId: "EXAVITQu4vr4xnSDxMaL", // Sarah (ElevenLabs) — showcase default
          voiceActive: false,
          password: "",
        });
      },
    }),
    {
      name: "hello22_onboarding",
      // Persist everything except the password (kept in memory only, never on disk).
      partialize: (s) => ({
        step: s.step,
        data: s.data,
        analyzed: s.analyzed,
        accountCreated: s.accountCreated,
        furthestStep: s.furthestStep,
        skippedWebsite: s.skippedWebsite,
        voiceId: s.voiceId,
        voiceActive: s.voiceActive,
      }),
      // Backfill any newly-added data fields for sessions persisted before they existed.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<OnboardingState>;
        return { ...current, ...p, data: { ...current.data, ...(p.data ?? {}) } };
      },
    },
  ),
);
