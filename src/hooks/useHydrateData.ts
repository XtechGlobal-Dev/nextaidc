import { useEffect, useRef } from "react";
import { useAuthStore } from "@/stores/useAuthStore";
import { useProfileStore } from "@/stores/useProfileStore";
import { useAgentStore } from "@/stores/useAgentStore";
import { useCallsStore } from "@/stores/useCallsStore";
import { useCrmStore } from "@/stores/useCrmStore";
import { useChatStore } from "@/stores/useChatStore";
import { useTrialStore } from "@/stores/useTrialStore";
import { hasCustomerWorkspace } from "@/lib/roles";

/** Hydrate every data store once per authenticated user. Keyed on user id, not just status —
 *  impersonation keeps status "authed" while the account changes. */
export function useHydrateData() {
  const status = useAuthStore((s) => s.status);
  const userId = useAuthStore((s) => s.user?.id ?? null);
  // STAFF / SUPER_ADMIN have no customer workspace — fetching would 404 and, worse, the
  // profile GET self-heals a Profile row into existence for an account that must never own one.
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

  // Ongoing live refresh lives in useLiveData; this hook only owns the one-time hydrate.
}
