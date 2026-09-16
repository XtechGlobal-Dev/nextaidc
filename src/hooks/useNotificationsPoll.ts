import { useEffect } from "react";
import { useNotificationStore } from "@/stores/useNotificationStore";

/** One hydrate on mount so the bell has content on first paint. No interval here — live
 *  updates, focus refresh and the fallback poll are all owned by useLiveData (SSE). */
export function useNotificationsPoll() {
  useEffect(() => {
    void useNotificationStore.getState().hydrate();
  }, []);
}
