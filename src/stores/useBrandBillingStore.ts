import { create } from "zustand";
import { api, type BrandBilling } from "@/lib/api";

// The signed-in brand's standing with the platform, for the layout's payment gate and banners. Not
// persisted: a stale "paid" must never let a locked panel open, and a stale "locked" would bounce a brand
// that just paid. Loaded for brand-side admin accounts only.

interface BrandBillingState {
  billing: BrandBilling | null;
  loaded: boolean;
  refresh: () => Promise<void>;
  /** Replace with a fresh copy (the Billing page's actions return one). */
  set: (billing: BrandBilling) => void;
  reset: () => void;
}

export const useBrandBillingStore = create<BrandBillingState>()((set) => ({
  billing: null,
  loaded: false,
  refresh: async () => {
    try {
      set({ billing: await api.brandAdmin.billing.get(), loaded: true });
    } catch {
      // Unreachable billing never locks anyone out.
      set({ loaded: true });
    }
  },
  set: (billing) => set({ billing, loaded: true }),
  reset: () => set({ billing: null, loaded: false }),
}));
