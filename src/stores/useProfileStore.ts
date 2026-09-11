import { create } from "zustand";
import { persist } from "zustand/middleware";
import { toast } from "sonner";
import type { Profile } from "@/types";
import { DEFAULT_PROFILE } from "@/data/defaults";
import { api, ApiError } from "@/lib/api";
import { sessionMark, sessionChanged } from "@/lib/sessionEpoch";
import { useAuthStore } from "@/stores/useAuthStore";

export const FREE_PLAN_MINUTES = 10;

type ProfileUsage = {
  callsHandled: number;
  minutesUsed: number;
  planMinutes: number;
  percent: number;
  unlimited: boolean;
};

interface ProfileState {
  profile: Profile;
  hydrate: () => Promise<void>;
  updateProfile: (patch: Partial<Profile>) => void;
  /** Persist call-forwarding choice / confirmation. `confirmed` maps to the
   *  forwardingConfirmedAt timestamp server-side (true = now, false = clear). */
  saveForwarding: (patch: { mode?: Profile["forwardingMode"]; confirmed?: boolean }) => void;
  activateNumber: () => void;
  loadUsage: () => Promise<ProfileUsage | null>;
  upgradeToPremium: () => void;
  /** True while the user is on the free tier (gates premium features). */
  isPremium: () => boolean;
  reset: () => void;
}

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : fallback;
}

export const useProfileStore = create<ProfileState>()(
  persist(
    (set, get) => ({
      profile: DEFAULT_PROFILE,
      hydrate: async () => {
        const mark = sessionMark();
        try {
          const data = await api.profile.get();
          // Drop a response that belongs to a previous account (switched while this
          // request was in flight) — otherwise it flashes the old profile.
          if (sessionChanged(mark)) return;
          // Merge with existing defaults for any missing fields.
          set((s) => ({ profile: { ...s.profile, ...data } }));
        } catch {
          /* never throw out of hydrate */
        }
      },
      updateProfile: (patch) => {
        set((s) => ({ profile: { ...s.profile, ...patch } }));
        // The auth store backs the header greeting/chip; keep its name in sync so
        // editing the profile name doesn't leave a stale "Good morning, <old>".
        if (patch.fullName !== undefined) {
          useAuthStore.getState().patchUser({ fullName: patch.fullName });
        }
        // Email is stored on the account (User table), which backs the header/auth
        // email fallback — mirror it into the auth store so it doesn't show stale.
        if (patch.email !== undefined) {
          useAuthStore.getState().patchUser({ email: patch.email });
        }
        type Persistable = Pick<
          Profile,
          "fullName" | "email" | "businessName" | "mobile" | "website" | "businessNumber" | "address" | "country" | "industry"
        >;
        const { fullName, email, businessName, mobile, website, businessNumber, address, country, industry } =
          patch as Partial<Persistable>;
        const payload: Partial<Persistable> = {};
        if (fullName !== undefined) payload.fullName = fullName;
        if (email !== undefined) payload.email = email;
        if (businessName !== undefined) payload.businessName = businessName;
        if (mobile !== undefined) payload.mobile = mobile;
        if (website !== undefined) payload.website = website;
        if (businessNumber !== undefined) payload.businessNumber = businessNumber;
        if (address !== undefined) payload.address = address;
        if (country !== undefined) payload.country = country;
        if (industry !== undefined) payload.industry = industry;
        void api.profile
          .update(payload)
          .then((profile) => set((s) => ({ profile: { ...s.profile, ...profile } })))
          .catch((e) => toast.error(errorMessage(e, "Failed to save profile")));
      },
      saveForwarding: ({ mode, confirmed }) => {
        // Optimistically reflect the choice; forwardingConfirmedAt mirrors the
        // boolean the server stamps.
        set((s) => ({
          profile: {
            ...s.profile,
            ...(mode !== undefined ? { forwardingMode: mode } : {}),
            ...(confirmed !== undefined
              ? { forwardingConfirmedAt: confirmed ? new Date().toISOString() : null }
              : {}),
          },
        }));
        void api.profile
          .update({
            ...(mode !== undefined ? { forwardingMode: mode } : {}),
            ...(confirmed !== undefined ? { forwardingConfirmed: confirmed } : {}),
          })
          .then((profile) => set((s) => ({ profile: { ...s.profile, ...profile } })))
          .catch((e) => toast.error(errorMessage(e, "Failed to save forwarding")));
      },
      activateNumber: () => {
        set((s) => ({ profile: { ...s.profile, numberActivated: true } }));
        void api.profile
          .activateNumber()
          .then((profile) => set((s) => ({ profile: { ...s.profile, ...profile } })))
          .catch((e) => toast.error(errorMessage(e, "Failed to activate number")));
      },
      loadUsage: async () => {
        try {
          return await api.profile.usage();
        } catch {
          return null;
        }
      },
      upgradeToPremium: () => set((s) => ({ profile: { ...s.profile, plan: "premium" } })),
      isPremium: () => get().profile.plan === "premium",
      reset: () => set({ profile: DEFAULT_PROFILE }),
    }),
    { name: "hello22_profile" },
  ),
);
