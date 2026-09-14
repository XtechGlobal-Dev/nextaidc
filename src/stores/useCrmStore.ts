import { create } from "zustand";
import { persist } from "zustand/middleware";
import { toast } from "sonner";
import type { CrmIntegration, CrmProvider } from "@/types";
import { DEFAULT_CRM } from "@/data/defaults";
import { api, ApiError } from "@/lib/api";
import { sessionMark, sessionChanged } from "@/lib/sessionEpoch";

interface CrmState {
  crm: CrmIntegration;
  hydrate: () => Promise<void>;
  selectProvider: (p: CrmProvider) => void;
  setCustomWebhook: (url: string) => void;
  setNexleon: (url: string, token: string) => void;
  connectGoogleCalendar: () => void;
  reset: () => void;
}

function persistCrm(patch: Partial<CrmIntegration>, fallback: string) {
  void api.crm.update(patch).catch((e) => {
    toast.error(e instanceof ApiError ? e.message : fallback);
  });
}

export const useCrmStore = create<CrmState>()(
  persist(
    (set) => ({
      crm: DEFAULT_CRM,
      hydrate: async () => {
        const mark = sessionMark();
        try {
          const crm = await api.crm.get();
          if (sessionChanged(mark)) return; // response belongs to a previous account
          set({ crm });
        } catch {
          /* never throw out of hydrate */
        }
      },
      selectProvider: (p) => {
        set((s) => ({ crm: { ...s.crm, connectedProvider: p } }));
        persistCrm({ connectedProvider: p }, "Failed to update CRM provider");
      },
      setCustomWebhook: (url) => {
        set((s) => ({ crm: { ...s.crm, customWebhookUrl: url } }));
        persistCrm({ customWebhookUrl: url }, "Failed to save webhook");
      },
      setNexleon: (url, formKey) => {
        // Real own-values also select Nexleon so delivery goes to their CRM. Clearing them
        // leaves the provider alone — empty values already fall back to the global default.
        const selectNexleon = url.trim().length > 0 && formKey.trim().length > 0;
        set((s) => ({
          crm: {
            ...s.crm,
            nexleonUrl: url,
            nexleonFormKey: formKey,
            ...(selectNexleon ? { connectedProvider: "perfex" as CrmProvider } : {}),
          },
        }));
        persistCrm(
          {
            nexleonUrl: url,
            nexleonFormKey: formKey,
            ...(selectNexleon ? { connectedProvider: "perfex" } : {}),
          },
          "Failed to save Nexleon CRM settings",
        );
      },
      connectGoogleCalendar: () => {
        set((s) => ({ crm: { ...s.crm, googleCalendarConnected: true } }));
        persistCrm({ googleCalendarConnected: true }, "Failed to connect calendar");
      },
      reset: () => set({ crm: DEFAULT_CRM }),
    }),
    { name: "hello22_crm" },
  ),
);
