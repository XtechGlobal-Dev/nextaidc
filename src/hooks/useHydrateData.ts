import { useEffect, useRef } from "react";
import { useAuthStore } from "@/stores/useAuthStore";
import { useProfileStore } from "@/stores/useProfileStore";
import { useAgentStore } from "@/stores/useAgentStore";
import { useCallsStore } from "@/stores/useCallsStore";
import { useCrmStore } from "@/stores/useCrmStore";
import { useChatStore } from "@/stores/useChatStore";
import { useTrialStore } from "@/stores/useTrialStore";
import { hasCustomerWorkspace } from "@/lib/roles";

/**
 * Loads server data into every data store once per authenticated user.
 * Re-hydrates whenever the signed-in account changes — not only on a fresh
 * login/logout but also when an admin enters or exits a customer's panel
 * (impersonation keeps status "authed" while the user id changes), so the new
 * account's data always loads fresh instead of showing the prior account's.
 */
export function useHydrateData() {
  const status = useAuthStore((s) => s.status);
  const userId = useAuthStore((s) => s.user?.id ?? null);
  // Accounts with no customer workspace (STAFF, SUPER_ADMIN) have no profile,
  // agent, calls or CRM to load. Fetching anyway is pure noise: a burst of empty
  // or 404 responses on every admin page load, and — worse — a GET that would
  // have the server self-heal a Profile row into existence for an account that
  // should never own one.
  const customerData = useAuthStore((s) => hasCustomerWorkspace(s.user?.role));
  // Tracks which user id we've already hydrated for, so a user switch re-runs.
  const hydratedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (status !== "authed" || !userId) {
      // Reset the guard so we re-hydrate on the next authentication.
      hydratedForRef.current = null;
      return;
    }
    if (hydratedForRef.current === userId) return;
    hydratedForRef.current = userId;

    if (!customerData) return;

    void useProfileStore.getState().hydrate();
    void useAgentStore.getState().hydrate();
    void useCallsStore.getState().hydrate();
    void useCrmStore.getState().hydrate();
    void useChatStore.getState().hydrate();
    void useTrialStore.getState().hydrate();
  }, [status, userId, customerData]);

  // The ongoing live refresh of trial / usage / calls (days countdown, minutes
  // meter, dashboard metrics) is driven centrally by useLiveData — see that hook.
  // This hook only owns the one-time per-user hydrate above.
}
