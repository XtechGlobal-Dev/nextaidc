import { useEffect } from "react";
import { useNotificationStore } from "@/stores/useNotificationStore";

/**
 * Tell the notification store which ticket conversation is open on screen.
 *
 * While it is open and the tab is visible, anything new about that ticket is
 * treated as seen — marked read rather than raised as a toast, since the reply
 * is already showing in the thread. Switching to another ticket, another page,
 * or a hidden tab lifts that, so notifications resume.
 *
 * Pass the id from the page's `?ticket=` param (null when no thread is open).
 * Works on every ticket surface, both lanes and both sides: the store only ever
 * matches on the ticket id in a notification's link.
 */
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
