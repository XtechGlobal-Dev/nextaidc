import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { TrialState } from "@/types";
import { api } from "@/lib/api";
import { sessionMark, sessionChanged } from "@/lib/sessionEpoch";

interface TrialStoreState {
  trial: TrialState | null;
  loading: boolean;
  hydrate: () => Promise<void>;
  reset: () => void;
}

export const useTrialStore = create<TrialStoreState>()(
  persist(
    (set) => ({
      trial: null,
      loading: false,
      hydrate: async () => {
        const mark = sessionMark();
        set({ loading: true });
        try {
          const { success: _success, ...state } = await api.trial.status();
          if (sessionChanged(mark)) return; // response belongs to a previous account
          set({ trial: state, loading: false });
        } catch {
          if (!sessionChanged(mark)) set({ loading: false });
        }
      },
      reset: () => set({ trial: null, loading: false }),
    }),
    // Cache the last entitlement so the sidebar meter doesn't flash "no entitlement"
    // on reload while /api/trial/status loads. Cleared on logout via reset().
    { name: "hello22_trial", partialize: (s) => ({ trial: s.trial }) },
  ),
);
