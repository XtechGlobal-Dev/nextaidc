import { useEffect } from "react";
import { useNotificationStore } from "@/stores/useNotificationStore";

/**
 * Loads server-recorded notifications once on mount so the bell is populated on
 * first paint. Live updates thereafter are PUSHED over SSE (see useLiveData),
 * which re-hydrates the bell the instant a notification-worthy event happens — so
 * there is no interval polling here anymore. The SSE driver also owns the
 * tab-focus refresh and the slow fallback used while the stream is disconnected.
 */
export function useNotificationsPoll() {
  useEffect(() => {
    void useNotificationStore.getState().hydrate();
  }, []);
}
