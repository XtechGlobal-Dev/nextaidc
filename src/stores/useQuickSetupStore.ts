import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CallLog } from "@/types";
import { useProfileStore } from "@/stores/useProfileStore";
import { api, type SubscriptionPlan } from "@/lib/api";

/** Persist "the user has seen the quick-setup modal" server-side so it never
 *  auto-opens again — even after a cache clear or on a new browser. Optimistically
 *  flips the local profile flag so the auto-open effect won't re-fire this session. */
function persistQuickSetupSeen() {
  if (useProfileStore.getState().profile.quickSetupSeenAt) return;
  useProfileStore.setState((s) => ({
    profile: { ...s.profile, quickSetupSeenAt: new Date().toISOString() },
  }));
  void api.profile.markQuickSetupSeen().catch(() => {
    /* best-effort — worst case it re-opens once more next login */
  });
}

// Choose Plan → Payment → Your Number → Go Live.
// Plan + Payment (steps 1-2) gate number assignment: a customer tries web calls on
// the trial freely from the dashboard, but must pick a plan + add a card before
// claiming a number. Already-subscribed users skip 1-2 (see QuickSetupModal).
export const QUICK_SETUP_STEPS = 4;
/** The "Your Number" step index — jumped to directly after the Payment step so the
 *  hasBilling "skip" effect can't race a relative next() into Go Live. */
export const QUICK_SETUP_NUMBER_STEP = 3;

interface QuickSetupState {
  open: boolean;
  step: number; // 1..6
  completed: boolean; // persisted — once true, never auto-opens
  dismissed: boolean; // transient — closed this session
  selectedNumber: string | null;
  forwarding: boolean;
  captured: CallLog | null; // the test call result shown in step 2
  generated: boolean;
  /** Stripe SetupIntent secret from the Plan step, consumed by the Payment step. */
  billingClientSecret: string | null;
  /** The plan that secret was minted for. The Payment step renders the shared
   *  CardForm, which has no idea what was picked two steps earlier — this is how
   *  its `card_added` analytics event names the plan being paid for. Session-only
   *  (not persisted), and cleared wherever the secret is. */
  billingPlan: SubscriptionPlan | null;

  openSetup: () => void;
  close: () => void;
  next: () => void;
  goTo: (step: number) => void;
  /** Store the real captured test call (shown in step 2). */
  setCaptured: (call: CallLog) => void;
  selectNumber: (n: string) => void;
  setForwarding: (b: boolean) => void;
  setBillingClientSecret: (s: string | null) => void;
  setBillingPlan: (p: SubscriptionPlan | null) => void;
  complete: () => void;
  /** Clear completion so the wizard opens fresh (e.g. after a new account). */
  resetSetup: () => void;
  /** Clear a prior dismissal so the wizard re-opens on the next login (kept across refreshes, reset per login). */
  resetDismiss: () => void;
}

export const useQuickSetupStore = create<QuickSetupState>()(
  persist(
    (set, get) => ({
      open: false,
      step: 1,
      completed: false,
      dismissed: false,
      selectedNumber: null,
      forwarding: false,
      captured: null,
      generated: false,
      billingClientSecret: null,
      billingPlan: null,

      openSetup: () =>
        set({
          open: true,
          step: 1,
          captured: null,
          generated: false,
          dismissed: false,
          billingClientSecret: null,
          billingPlan: null,
        }),
      close: () => {
        // Skipping/closing counts as "seen" — record it server-side so the modal
        // doesn't auto-open again after a logout/cache-clear/relogin.
        persistQuickSetupSeen();
        set({ open: false, dismissed: true });
      },
      next: () => set((s) => ({ step: Math.min(QUICK_SETUP_STEPS, s.step + 1) })),
      goTo: (step) => set({ step: Math.max(1, Math.min(QUICK_SETUP_STEPS, step)) }),

      setCaptured: (call) => set({ captured: call, generated: true }),

      selectNumber: (n) => set({ selectedNumber: n }),
      setForwarding: (b) => set({ forwarding: b }),
      setBillingClientSecret: (s) => set({ billingClientSecret: s }),
      setBillingPlan: (p) => set({ billingPlan: p }),

      complete: () => {
        const num = get().selectedNumber;
        if (num) useProfileStore.getState().updateProfile({ receptionistNumber: num });
        persistQuickSetupSeen();
        set({ completed: true, open: false });
      },

      resetSetup: () =>
        set({
          completed: false,
          dismissed: false,
          open: false,
          generated: false,
          step: 1,
          captured: null,
          billingClientSecret: null,
          billingPlan: null,
        }),

      resetDismiss: () => set({ dismissed: false, open: false, step: 1 }),
    }),
    {
      name: "hello22_quick_setup",
      // Persist long-lived flags + the dismissal so a refresh doesn't reopen the
      // wizard. The dismissal is cleared on each login (see useAuthStore) so it
      // shows again next time the user signs in until they complete it.
      partialize: (s) => ({
        completed: s.completed,
        dismissed: s.dismissed,
        selectedNumber: s.selectedNumber,
        forwarding: s.forwarding,
      }),
    },
  ),
);
