// The incoming-call ring mirrored into the OS notification tray, via public/sw.js — a plain
// page-level Notification can't carry Accept/Reject buttons, only one raised by a service worker
// can. Gated behind the same permission + in-app switch as every other system alert.

import { alertIcon, alertsEnabled } from "@/lib/browserNotifications";

let registration: ServiceWorkerRegistration | null = null;

async function ensureServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (registration) return registration;
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    registration = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    return registration;
  } catch {
    return null;
  }
}

export interface CallNotificationInput {
  ticketId: string;
  fromName: string;
  mode: "audio" | "video";
  subject?: string;
  link: string;
}

function tagFor(ticketId: string): string {
  return `call-${ticketId}`;
}

/** Raises the OS notification for a ring. No-op where system alerts aren't permitted/enabled —
 *  the in-app ring dialog is the fallback either way. */
export async function showCallNotification(invite: CallNotificationInput): Promise<void> {
  if (!alertsEnabled()) return;
  const reg = await ensureServiceWorker();
  const worker = reg?.active;
  if (!worker) return;
  worker.postMessage({
    type: "show-call-notification",
    ticketId: invite.ticketId,
    tag: tagFor(invite.ticketId),
    title: `Incoming ${invite.mode === "video" ? "video" : "voice"} call — ${invite.fromName}`,
    body: invite.subject ? `About "${invite.subject}"` : "Tap Accept to join",
    icon: alertIcon(),
    url: invite.link,
  });
}

/** Dismisses the tray notification — the ring was answered, declined, ended, or timed out. */
export async function clearCallNotification(ticketId: string): Promise<void> {
  const reg = await ensureServiceWorker();
  reg?.active?.postMessage({ type: "clear-call-notification", tag: tagFor(ticketId) });
}

export type CallNotificationAction = "accept" | "reject" | "open";

/** Fires when the tray notification (or one of its buttons) is tapped. */
export function subscribeCallNotificationAction(
  handler: (ticketId: string, action: CallNotificationAction) => void,
): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return () => {};
  const onMessage = (event: MessageEvent) => {
    const data = event.data;
    if (data?.type === "call-notification-action" && data.ticketId) {
      handler(data.ticketId, (data.action ?? "open") as CallNotificationAction);
    }
  };
  navigator.serviceWorker.addEventListener("message", onMessage);
  return () => navigator.serviceWorker.removeEventListener("message", onMessage);
}
