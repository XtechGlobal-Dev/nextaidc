import { create } from "zustand";
import { toast } from "sonner";
import type { HumanTransferSettings, TransferDepartment } from "@/types";
import { api, ApiError } from "@/lib/api";

/**
 * Human Call Transfer settings store. Loaded on demand (not persisted — a
 * settings concern, always fetched fresh). Updates are optimistic and reconciled
 * with the server response.
 */
interface TransferState {
  settings: HumanTransferSettings | null;
  departments: TransferDepartment[];
  loading: boolean;
  hydrate: () => Promise<void>;
  updateSettings: (
    patch: Partial<
      Pick<HumanTransferSettings, "enabled" | "transferNumber" | "ringTimeoutSec" | "fallbackMessage">
    >,
  ) => Promise<void>;
  /** Commit everything at once: the full department list plus the ring/end-message
   *  settings. Backs the single "Save Changes" button. */
  saveDraft: (
    departments: Pick<
      TransferDepartment,
      "name" | "number" | "description" | "enabled" | "ringTimeoutSec" | "fallbackMessage"
    >[],
    settingsPatch: Pick<HumanTransferSettings, "ringTimeoutSec" | "fallbackMessage">,
  ) => Promise<void>;
  reset: () => void;
}

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : fallback;
}

export const useTransferStore = create<TransferState>((set, get) => ({
  settings: null,
  departments: [],
  loading: false,
  hydrate: async () => {
    set({ loading: true });
    try {
      const [settings, departments] = await Promise.all([
        api.transfer.get(),
        api.transfer.departments.list(),
      ]);
      set({ settings, departments });
    } catch {
      /* never throw out of hydrate */
    } finally {
      set({ loading: false });
    }
  },
  saveDraft: async (departments, settingsPatch) => {
    try {
      // Settings first, then the atomic department replace (which resyncs the
      // live assistant once with the full, final config).
      const settings = await api.transfer.update(settingsPatch);
      const saved = await api.transfer.departments.replace(departments);
      set({ settings, departments: saved });
    } catch (e) {
      toast.error(errorMessage(e, "Failed to save transfer settings"));
      void get().hydrate();
      throw e;
    }
  },
  updateSettings: async (patch) => {
    // Optimistic — reflect the toggle/field immediately.
    set((s) => (s.settings ? { settings: { ...s.settings, ...patch } } : s));
    try {
      set({ settings: await api.transfer.update(patch) });
    } catch (e) {
      toast.error(errorMessage(e, "Failed to save transfer settings"));
      void get().hydrate();
    }
  },
  reset: () => set({ settings: null, departments: [], loading: false }),
}));
