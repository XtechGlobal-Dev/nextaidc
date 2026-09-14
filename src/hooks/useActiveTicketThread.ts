import { useEffect } from "react";
import { useNotificationStore } from "@/stores/useNotificationStore";

/** Tell the notification store which ticket thread is on screen (id from `?ticket=`, null if none).
 *  While open and visible, news about it is marked read instead of toasted. */
export function useActiveTicketThread(ticketId: string | null | undefined) {
  useEffect(() => {
    const id = ticketId || null;
    useNotificationStore.getState().setActiveThread(id);
    if (!id) return;

    const markSeen = () => {
      if (document.visibilityState !== "hidden") {
        useNotificationStore.getState().markThreadRead(id);
      }
    };
    // Opening the thread reads whatever was already waiting about it, and coming
    // back to a tab that toasted while hidden reads those too.
    markSeen();
    document.addEventListener("visibilitychange", markSeen);
    return () => {
      document.removeEventListener("visibilitychange", markSeen);
      useNotificationStore.getState().setActiveThread(null);
    };
  }, [ticketId]);
}
