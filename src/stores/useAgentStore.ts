import { create } from "zustand";
import { persist } from "zustand/middleware";
import { toast } from "sonner";
import type { AgentConfig, AgentSectionKey } from "@/types";
import { DEFAULT_AGENT_CONFIG } from "@/data/defaultAgentConfig";
import { normalizeSmsInfoItems } from "@/data/smsInfoItems";
import {
  compileMasterPrompt,
  renameBusinessInConfig,
  DEFAULT_PROMPT_TEMPLATE,
  type CompileContext,
} from "@/lib/compilePrompt";
import { clampName } from "@/lib/limits";
import { api, ApiError } from "@/lib/api";
import { sessionMark, sessionChanged } from "@/lib/sessionEpoch";
import { useProfileStore } from "@/stores/useProfileStore";

type Updater<T> = (prev: T) => T;

const SECTION_KEYS: AgentSectionKey[] = ["identity", "knowledge", "rules", "automations", "advanced"];

/** The master prompt is recompiled from the other sections on every edit, so an
 *  auto-generated prompt differing from the snapshot is just an echo of a change
 *  already counted in its own section — drop it from the Advanced comparison.
 *  A manually edited prompt (masterPromptDirty) is a real Advanced change and
 *  stays in. */
function comparableSection(config: AgentConfig, key: AgentSectionKey) {
  const section = config[key];
  if (key !== "advanced") return section;
  const advanced = section as AgentConfig["advanced"];
  if (advanced.masterPromptDirty) return advanced;
  const { masterPrompt: _omitted, ...rest } = advanced;
  return rest;
}

/** Sections whose current draft differs from the last saved snapshot. Deriving
 *  dirtiness from a diff (instead of latching a flag on edit) means undoing a
 *  change by hand clears the unsaved-changes state again. */
function diffSections(config: AgentConfig, savedConfig: AgentConfig): AgentSectionKey[] {
  return SECTION_KEYS.filter(
    (k) => JSON.stringify(comparableSection(config, k)) !== JSON.stringify(comparableSection(savedConfig, k)),
  );
}

/** Country / Region and Industry sit on the PROFILE, not the config — their only
 *  trace here is the recompiled master prompt, which the comparison above drops
 *  on purpose. So Identity is also dirty whenever they differ from the values in
 *  effect when the section was last clean. Captured on the first such edit (see
 *  noteContextChange), which makes this a comparison and not a latch: put the
 *  original industry back and the change disappears, exactly like editing a
 *  config field back by hand. */
export interface ProfileContext {
  country: string;
  industry: string;
}

function contextChanged(baseline: ProfileContext | null): boolean {
  if (!baseline) return false;
  const p = useProfileStore.getState().profile;
  return (p.country ?? "") !== baseline.country || (p.industry ?? "") !== baseline.industry;
}

function deriveDirty(config: AgentConfig, savedConfig: AgentConfig, baseline: ProfileContext | null = null) {
  const diffed = diffSections(config, savedConfig);
  const dirtySections = contextChanged(baseline)
    ? [...new Set<AgentSectionKey>([...diffed, "identity"])]
    : diffed;
  return { dirty: dirtySections.length > 0, dirtySections };
}

/** Normalize an incoming config so legacy over-long names (saved before the
 *  40-char cap) display and persist within the limit instead of showing "73/40". */
function clampConfigNames(config: AgentConfig): AgentConfig {
  if (!config?.identity) return config;
  return {
    ...config,
    identity: {
      ...config.identity,
      assistantName: clampName(config.identity.assistantName),
      businessName: clampName(config.identity.businessName),
    },
  };
}

interface AgentState {
  config: AgentConfig;
  /** Snapshot of the last persisted config — the baseline we revert to when the
   *  user discards unsaved edits ("Don't save"). */
  savedConfig: AgentConfig;
  /** The admin-editable prompt scaffold (from the server). Blank → the built-in
   *  DEFAULT_PROMPT_TEMPLATE. Used to compile the master prompt so the preview
   *  matches what the server syncs to the live assistant. */
  promptTemplate: string;
  /** Whether the customer's prompt template snapshot matches the latest global template. */
  promptTemplateIsLatest: boolean;
  /** ISO timestamp of last save, or null. */
  lastSyncedAt: string | null;
  /** True when the last save stored the config but the live Vapi push failed —
   *  the live agent is running an older prompt until a re-save succeeds. */
  syncFailed: boolean;
  /** Provisioning state of this customer's agent: "pending" until an admin approves. */
  status: string | null;
  dirty: boolean;
  /** Sections edited since the last successful save — surfaced as "Pending" in the
   *  builder rail so a changed-but-unsaved section never looks saved/complete. */
  dirtySections: AgentSectionKey[];
  /** Country / Industry as they were when Identity was last clean, or null when
   *  they haven't been touched since. Cleared on save/revert/hydrate. */
  contextBaseline: ProfileContext | null;
  /** Record the profile Country / Industry in effect BEFORE this edit, so the
   *  unsaved-changes state can compare rather than latch — going back to the
   *  original value clears it again. Only the first change captures a baseline. */
  noteContextChange: (previous: ProfileContext) => void;
  /** Load config from the backend. */
  hydrate: () => Promise<void>;
  /** Patch a top-level section, recompiling the master prompt if needed. */
  updateSection: <K extends AgentSectionKey>(
    key: K,
    patch: Partial<AgentConfig[K]> | Updater<AgentConfig[K]>,
  ) => void;
  /** Replace the whole config (e.g. import). */
  setConfig: (config: AgentConfig) => void;
  /** Carry a business rename through the free text that named the old business
   *  (onboarding-generated scenarios, FAQs, facts). `previousName` is the name
   *  that text was written against. No-op when nothing mentions it. */
  propagateBusinessRename: (previousName: string) => void;
  /** Manually edit the master prompt (marks it dirty so it won't be overwritten). */
  setMasterPrompt: (text: string) => void;
  /** Re-generate the master prompt from structured config (clears dirty flag). */
  regenerateMasterPrompt: () => void;
  /** Fetch the admin's latest master template and rebuild the prompt on it —
   *  the user's manual way to adopt template changes (clears dirty flag). */
  syncMasterPromptToTemplate: () => Promise<boolean>;
  /** Persist to backend and deploy to the live Vapi agent. */
  save: () => Promise<void>;
  /** Discard unsaved edits, restoring the last persisted config. */
  revert: () => void;
  /** Adopt the latest admin prompt template (clears the "newer template" banner). */
  adoptLatestTemplate: () => Promise<void>;
  /** Push the saved config to the live Vapi agent. */
  sync: () => Promise<void>;
  reset: () => void;
}

function getCompileCtx(): CompileContext {
  const p = useProfileStore.getState().profile;
  return { country: p.country || undefined, industry: p.industry || undefined };
}

function recompile(config: AgentConfig, template: string): AgentConfig {
  if (config.advanced.masterPromptDirty) return config;
  return {
    ...config,
    advanced: { ...config.advanced, masterPrompt: compileMasterPrompt(config, template, getCompileCtx()) },
  };
}

export const useAgentStore = create<AgentState>()(
  persist(
    (set, get) => ({
      config: DEFAULT_AGENT_CONFIG,
      savedConfig: DEFAULT_AGENT_CONFIG,
      promptTemplate: DEFAULT_PROMPT_TEMPLATE,
      promptTemplateIsLatest: true,
      lastSyncedAt: new Date().toISOString(),
      syncFailed: false,
      status: null,
      dirty: false,
      dirtySections: [],
      contextBaseline: null,
      noteContextChange: (previous) =>
        set((state) => {
          // Keep the FIRST baseline: with two edits (Plumbing → Electrician →
          // Plumbing) a later capture would make the round trip look changed.
          const contextBaseline = state.contextBaseline ?? previous;
          return { contextBaseline, ...deriveDirty(state.config, state.savedConfig, contextBaseline) };
        }),
      hydrate: async () => {
        const mark = sessionMark();
        try {
          const data = await api.agent.get();
          if (sessionChanged(mark)) return; // response belongs to a previous account
          const config = clampConfigNames(data.agentConfig);
          // Adopt the admin scaffold (blank → keep the built-in default) and
          // recompile so the preview reflects it immediately.
          const promptTemplate = data.promptTemplate?.trim() ? data.promptTemplate : DEFAULT_PROMPT_TEMPLATE;
          const promptTemplateIsLatest = data.promptTemplateIsLatest !== false;
          const recompiled = recompile(config, promptTemplate);
          set({ config: recompiled, savedConfig: recompiled, promptTemplate, promptTemplateIsLatest, lastSyncedAt: data.lastSyncedAt, status: data.status, dirty: false, dirtySections: [], contextBaseline: null });
        } catch {
          /* never throw out of hydrate */
        }
      },
      updateSection: (key, patch) =>
        set((state) => {
          const prevSection = state.config[key];
          const nextSection =
            typeof patch === "function"
              ? (patch as Updater<typeof prevSection>)(prevSection)
              : { ...prevSection, ...patch };
          const nextConfig = recompile({ ...state.config, [key]: nextSection }, state.promptTemplate);
          return { config: nextConfig, ...deriveDirty(nextConfig, state.savedConfig, state.contextBaseline) };
        }),
      setConfig: (config) =>
        set((state) => {
          const nextConfig = recompile(config, state.promptTemplate);
          return { config: nextConfig, ...deriveDirty(nextConfig, state.savedConfig, state.contextBaseline) };
        }),
      propagateBusinessRename: (previousName) =>
        set((state) => {
          const renamed = renameBusinessInConfig(state.config, previousName, state.config.identity.businessName);
          if (renamed === state.config) return {}; // nothing named the old business
          const nextConfig = recompile(renamed, state.promptTemplate);
          return { config: nextConfig, ...deriveDirty(nextConfig, state.savedConfig, state.contextBaseline) };
        }),
      setMasterPrompt: (text) =>
        set((state) => {
          const nextConfig = {
            ...state.config,
            advanced: { ...state.config.advanced, masterPrompt: text, masterPromptDirty: true },
          };
          return { config: nextConfig, ...deriveDirty(nextConfig, state.savedConfig, state.contextBaseline) };
        }),
      regenerateMasterPrompt: () =>
        set((state) => {
          const nextConfig = {
            ...state.config,
            advanced: {
              ...state.config.advanced,
              masterPrompt: compileMasterPrompt(state.config, state.promptTemplate, getCompileCtx()),
              masterPromptDirty: false,
            },
          };
          return { config: nextConfig, ...deriveDirty(nextConfig, state.savedConfig, state.contextBaseline) };
        }),
      syncMasterPromptToTemplate: async () => {
        try {
          // Pull the admin's current scaffold fresh so the rebuild uses the
          // latest template, not the one cached at page load.
          const data = await api.agent.get();
          const promptTemplate = data.promptTemplate?.trim() ? data.promptTemplate : DEFAULT_PROMPT_TEMPLATE;
          set((state) => {
            const nextConfig = {
              ...state.config,
              advanced: {
                ...state.config.advanced,
                masterPrompt: compileMasterPrompt(state.config, promptTemplate),
                masterPromptDirty: false,
              },
            };
            return { promptTemplate, config: nextConfig, ...deriveDirty(nextConfig, state.savedConfig, state.contextBaseline) };
          });
          return true;
        } catch {
          return false;
        }
      },
      save: () => {
        const config = get().config;
        return api.agent
          .save(config)
          .then((res) => {
            // Adopt the server's canonical config — it may have normalised the
            // voice id and re-matched a default assistant name (Jessica/Mark)
            // to the newly picked voice's gender.
            const saved = res.agentConfig ?? config;
            set({ config: saved, savedConfig: saved, lastSyncedAt: res.lastSyncedAt, status: res.status, dirty: false, dirtySections: [], contextBaseline: null, syncFailed: !res.synced });
            // Saving can provision the agent + assign a receptionist number (esp. the
            // admin's first save), so refresh the profile to surface the new number.
            void useProfileStore.getState().hydrate();
            if (res.synced) {
              toast.success("Saved & deployed to your live agent");
            } else if (res.syncQueued) {
              // Saved, the live push failed, and the server has queued a retry —
              // so promise the catch-up instead of asking for a Save the user
              // would have no way of knowing was still needed.
              toast.warning("Saved — your live agent will update shortly", {
                description: res.syncError
                  ? `Couldn't reach the voice service (${res.syncError}). We'll keep retrying automatically.`
                  : "Couldn't reach the voice service. We'll keep retrying automatically.",
              });
            } else {
              // The config saved, but the live Vapi push didn't go through — say
              // so (don't let the user assume their agent updated).
              toast.warning("Saved, but couldn't update your live agent", {
                description: res.syncError
                  ? `${res.syncError} — try Save again.`
                  : "Try Save again in a moment.",
              });
            }
          })
          .catch((e) => {
            toast.error(e instanceof ApiError ? e.message : "Failed to save agent");
          });
      },
      revert: () => set((state) => ({ config: state.savedConfig, dirty: false, dirtySections: [], contextBaseline: null })),
      adoptLatestTemplate: async () => {
        try {
          const res = await api.agent.adoptLatestTemplate();
          const config = clampConfigNames(res.agentConfig);
          const promptTemplate = res.promptTemplate?.trim() ? res.promptTemplate : DEFAULT_PROMPT_TEMPLATE;
          set({ config, savedConfig: config, promptTemplate, promptTemplateIsLatest: true, dirty: false, dirtySections: [], contextBaseline: null });
          toast.success("Prompt template updated to the latest version");
        } catch (e) {
          toast.error(e instanceof ApiError ? e.message : "Failed to update template");
        }
      },
      sync: async () => {
        try {
          await api.agent.sync();
          toast.success("Synced to your live agent");
        } catch (e) {
          if (e instanceof ApiError && e.status === 501) {
            toast.info("Voice calling isn't configured yet");
          } else {
            toast.error(e instanceof ApiError ? e.message : "Failed to sync agent");
          }
        }
      },
      reset: () =>
        set({ config: DEFAULT_AGENT_CONFIG, savedConfig: DEFAULT_AGENT_CONFIG, dirty: false, dirtySections: [], contextBaseline: null, lastSyncedAt: new Date().toISOString(), syncFailed: false, promptTemplateIsLatest: true }),
    }),
    {
      name: "hello22_agent_config",
      version: 1,
      // v0 → v1: owner call-summary channels became on-by-default. Flip them on
      // once for existing users so their summaries start delivering to the account
      // email / mobile (the user can still pause any channel afterwards).
      migrate: (persisted, version) => {
        const p = (persisted ?? {}) as Partial<AgentState>;
        if (version < 1) {
          const activate = (c?: AgentConfig) =>
            c && {
              ...c,
              automations: {
                ...c.automations,
                ownerEmailSummary: true,
                ownerSmsSummary: true,
                ownerWhatsAppSummary: true,
              },
            };
          if (p.config) p.config = activate(p.config) as AgentConfig;
          if (p.savedConfig) p.savedConfig = activate(p.savedConfig) as AgentConfig;
        }
        return p;
      },
      // Backfill any config fields added after a user's state was persisted, so
      // older localStorage (missing newly-added section keys) can't crash the UI.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AgentState>;
        const fillAutomations = (saved?: AgentConfig["automations"]) => {
          const merged = { ...DEFAULT_AGENT_CONFIG.automations, ...saved };
          // Legacy config (pre-feature, no summary* override key) → summary
          // channels on by default. Mirrors the server's normalizeAutomations.
          if (saved?.summaryEmail === undefined) {
            merged.ownerEmailSummary = true;
            merged.ownerSmsSummary = true;
            merged.ownerWhatsAppSummary = true;
          }
          // Resolve to a fresh list — the spread above shares DEFAULT_AGENT_CONFIG's
          // seed array, so editing an item would mutate the defaults themselves.
          merged.smsOnRequest = { items: normalizeSmsInfoItems(saved?.smsOnRequest?.items) };
          return merged;
        };
        const fill = (saved?: AgentConfig): AgentConfig => ({
          identity: { ...DEFAULT_AGENT_CONFIG.identity, ...saved?.identity },
          knowledge: { ...DEFAULT_AGENT_CONFIG.knowledge, ...saved?.knowledge },
          rules: { ...DEFAULT_AGENT_CONFIG.rules, ...saved?.rules },
          automations: fillAutomations(saved?.automations),
          advanced: { ...DEFAULT_AGENT_CONFIG.advanced, ...saved?.advanced },
        });
        // Unsaved edits must NOT survive a browser refresh: reload the last-saved
        // snapshot and drop any dirty draft + flags. (hydrate() then refreshes this
        // from the backend once the user is authenticated.)
        const savedConfig = fill(p.savedConfig);
        return {
          ...current,
          ...p,
          config: savedConfig,
          savedConfig,
          // The prompt scaffold is global + server-owned — never trust a stale
          // persisted copy; start from the default and let hydrate() refresh it.
          promptTemplate: DEFAULT_PROMPT_TEMPLATE,
          dirty: false,
          dirtySections: [],
          // Same rule for the profile-side baseline — a stale one would resurrect
          // an "unsaved change" for a Country/Industry edit the refresh dropped.
          contextBaseline: null,
        };
      },
    },
  ),
);
