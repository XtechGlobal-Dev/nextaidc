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

/** Clear every user-scoped store on login/logout. Persisted stores survive logout, and a next user with no row
 *  (STAFF has no Profile, so /api/profile 404s) never overwrites the stale copy. Global stores (branding, UI prefs) are left alone. */
export function resetUserStores(): void {
  // Bump FIRST so an in-flight hydrate/poll for the old account is dropped as stale
  // instead of flashing the wrong account for 2-3s.
  bumpSession();
  useProfileStore.getState().reset();
  useAgentStore.getState().reset();
  useCallsStore.getState().reset();
  useCrmStore.getState().reset();
  useChatStore.getState().reset();
  useOnboardingStore.getState().reset();
  useQuickSetupStore.getState().resetDismiss();
  useTrialStore.getState().reset();
  // Clear LOCAL notification state only; never call the API here, that would
  // delete the signed-out user's notifications.
  useNotificationStore.setState({ notifications: [], unreadCount: 0, hydrated: false });
}
