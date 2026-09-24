// Minimal service worker — exists only to raise the incoming-call system notification with
// Accept/Reject action buttons. A plain `new Notification()` from the page can't carry actions;
// only a notification shown through a service worker's registration can. No caching, no offline
// support — this worker does nothing but relay call-ring messages to and from the OS tray.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data || {};

  if (data.type === "show-call-notification") {
    event.waitUntil(
      self.registration.showNotification(data.title, {
        body: data.body,
        tag: data.tag,
        icon: data.icon,
        badge: data.icon,
        // Stays up until acted on — a ring that auto-dismisses defeats the point.
        requireInteraction: true,
        // The page already loops the ringtone mp3; a second OS chime would double up.
        silent: true,
        data: { ticketId: data.ticketId, url: data.url },
        actions: [
          { action: "accept", title: "Accept" },
          { action: "reject", title: "Reject" },
        ],
      }),
    );
  } else if (data.type === "clear-call-notification") {
    event.waitUntil(
      self.registration.getNotifications({ tag: data.tag }).then((list) => {
        for (const n of list) n.close();
      }),
    );
  }
});

self.addEventListener("notificationclick", (event) => {
  const action = event.action || "open";
  const { ticketId, url } = event.notification.data || {};
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (list) => {
      for (const client of list) {
        client.postMessage({ type: "call-notification-action", ticketId, action });
        if ("focus" in client) await client.focus();
        return;
      }
      // No tab open at all (rare — the ring only fires while one is connected to the live
      // stream) — open one and let the app pick the invite back up from there.
      if (url && self.clients.openWindow) await self.clients.openWindow(url);
    }),
  );
});
