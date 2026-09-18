import { useCallback, useEffect } from "react";
import { useAuthStore } from "@/stores/useAuthStore";
import { useNotificationStore } from "@/stores/useNotificationStore";
import { useOpenNotification } from "@/components/notifications/NotificationList";
import {
  alertPermission,
  askedAlready,
  markAsked,
  requestAlertPermission,
  setAlertClickHandler,
  type AlertPayload,
} from "@/lib/browserNotifications";

// Browser alerts, wired to the app: clicking one lands on the page it is about, and a new session is
// asked for permission once. Mount once in AppLayout, alongside the other live-data hooks.

/** Firefox and Safari only open the permission prompt from a user gesture, and Chrome treats a
 *  gesture-less ask as a candidate for its quiet UI — so we wait for the first real interaction. */
const GESTURES = ["pointerdown", "keydown"] as const;

export function useBrowserAlerts(): void {
  const status = useAuthStore((s) => s.status);
  const userId = useAuthStore((s) => s.user?.id);
  const openNotification = useOpenNotification();

  // Clicking a system alert should behave exactly like clicking the row in the panel: mark it read
  // and route. The stored row is the source of truth; the payload stands in if it has since gone.
  const handleClick = useCallback(
    (n: AlertPayload) => {
      const stored = useNotificationStore.getState().notifications.find((x) => x.id === n.id);
      openNotification(
        stored ?? {
          id: n.id,
          type: "system",
          title: n.title,
          message: n.message,
          read: false,
          createdAt: new Date().toISOString(),
          link: n.link,
        },
      );
    },
    [openNotification],
  );

  useEffect(() => {
    setAlertClickHandler(handleClick);
    return () => setAlertClickHandler(null);
  }, [handleClick]);

  useEffect(() => {
    // Only a signed-in account is asked, and only while the browser has no answer yet: once it says
    // granted or denied, asking again is either pointless or impossible.
    if (status !== "authed" || !userId) return;
    if (alertPermission() !== "default" || askedAlready(userId)) return;

    const cleanup = () => {
      for (const evt of GESTURES) window.removeEventListener(evt, ask);
    };
    const ask = () => {
      cleanup();
      markAsked(userId);
      void requestAlertPermission();
    };
    for (const evt of GESTURES) window.addEventListener(evt, ask, { once: true });
    return cleanup;
  }, [status, userId]);
}
