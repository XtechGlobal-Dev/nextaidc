import { useProfileStore } from "@/stores/useProfileStore";
import { useAgentStore } from "@/stores/useAgentStore";
import { useCallsStore } from "@/stores/useCallsStore";
import { useCrmStore } from "@/stores/useCrmStore";
import { useChatStore } from "@/stores/useChatStore";
import { useOnboardingStore } from "@/stores/useOnboardingStore";
import { useQuickSetupStore } from "@/stores/useQuickSetupStore";
import { useNotificationStore } from "@/stores/useNotificationStore";
import { useTrialStore } from "@/stores/useTrialStore";
import { bumpSession } from "@/lib/sessionEpoch";

/**
 * Clear every user-scoped store so one account's cached data can never bleed
 * into the next account signed in on the same browser.
 *
 * Most of these stores `persist` to localStorage, which survives a logout. If
 * the next user has no row for a given resource (e.g. a STAFF account has no
 * Profile, so `GET /api/profile` 404s), nothing overwrites the stale copy — so
 * the previous user's profile/agent/etc. stays visible. Resetting on every
 * login + logout guarantees a clean slate before the new user's data hydrates.
 *
 * Global, non-personal stores (branding, UI prefs) are intentionally
 * left untouched.
 */
export function resetUserStores(): void {
  // Advance the session FIRST, so any hydrate/poll response already in flight for
  // the previous account is recognised as stale and dropped instead of landing in
  // the new account's store (the "wrong account flashes for 2-3s" bug).
  bumpSession();
  useProfileStore.getState().reset();
  useAgentStore.getState().reset();
  useCallsStore.getState().reset();
  useCrmStore.getState().reset();
  useChatStore.getState().reset();
  useOnboardingStore.getState().reset();
  useQuickSetupStore.getState().resetDismiss();
  useTrialStore.getState().reset();
  // Notifications aren't persisted, but clear the in-memory copy so a same-tab
  // user switch doesn't flash the prior user's items. Clear LOCAL state only —
  // never call the API (that would delete the signed-out user's notifications).
  useNotificationStore.setState({ notifications: [], unreadCount: 0, hydrated: false });
}
