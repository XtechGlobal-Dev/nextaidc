// System notifications for in-app notifications: the same rows the bell lists, delivered by the
// browser so they land even when the tab is in the background.
//
// One gate, and it is the browser's: the viewer allows notifications for this site, or they don't.
// There is deliberately no in-app on/off of our own — a second switch could only ever disagree with
// the browser and leave someone staring at "On" while nothing arrives. All we do is ask.
//
// Every browser call here is wrapped: iOS Safari has no Notification constructor, a private window
// can throw on storage, and an embedded webview may expose the name but refuse the call.

export type AlertPermission = "unsupported" | "default" | "granted" | "denied";

/** Per-tab marker that this account has already been asked, so a reload doesn't nag. */
const ASKED_KEY_PREFIX = "notifications.browserAlerts.asked.";

/** What a browser alert needs to know about a notification. Structurally the store's AppNotification. */
export interface AlertPayload {
  id: string;
  title: string;
  message: string;
  link?: string;
}

function supported(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      "Notification" in window &&
      typeof window.Notification?.requestPermission === "function"
    );
  } catch {
    return false;
  }
}

/** Where the browser stands on notifications for this origin. */
export function alertPermission(): AlertPermission {
  if (!supported()) return "unsupported";
  try {
    const p = window.Notification.permission;
    return p === "granted" || p === "denied" ? p : "default";
  } catch {
    return "unsupported";
  }
}

/** Whether a notification raised now would actually reach the desktop. The browser's permission is
 *  the only gate — there is no separate in-app switch to get out of step with it. */
export function alertsEnabled(): boolean {
  return alertPermission() === "granted";
}

/* --------------------------- what the footer row shows -------------------------- */

/**  ask — the browser hasn't been asked yet, so offer the Allow button
 *  on — granted; alerts are being delivered
 *  blocked — the viewer said no, or the browser did; only site settings can undo it
 *  unsupported — this browser has no notifications at all */
export type AlertState = "ask" | "on" | "blocked" | "unsupported";

/** Read fresh every time: the permission is the browser's to change, from its own site settings. */
export function alertState(): AlertState {
  const permission = alertPermission();
  if (permission === "unsupported") return "unsupported";
  if (permission === "denied") return "blocked";
  if (permission === "granted") return "on";
  return "ask";
}

const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/** Subscribes to every way the permission can change: this tab asking for it, or the browser's own
 *  site settings. One shared source, so two copies of the row on screen can never disagree. */
export function subscribeAlertState(onChange: () => void): () => void {
  listeners.add(onChange);
  const cleanups: (() => void)[] = [() => listeners.delete(onChange)];

  // Coming back to the tab is the moment a change made in site settings becomes visible.
  const onVisible = () => onChange();
  document.addEventListener("visibilitychange", onVisible);
  cleanups.push(() => {
    document.removeEventListener("visibilitychange", onVisible);
  });

  // Where supported, the permission itself is observable and needs no tab switch.
  let live = true;
  void navigator.permissions
    ?.query({ name: "notifications" as PermissionName })
    .then((status) => {
      if (!live) return;
      status.onchange = onChange;
      cleanups.push(() => {
        status.onchange = null;
      });
    })
    .catch(() => {});

  return () => {
    live = false;
    for (const fn of cleanups) fn();
  };
}

/** True once this account has been asked in this tab. Per-tab on purpose: a reload must not re-prompt,
 *  a fresh session (new tab, or another account signing in here) asks again. */
export function askedAlready(userId: string | null | undefined): boolean {
  if (!userId) return true; // nobody to ask for
  try {
    return sessionStorage.getItem(ASKED_KEY_PREFIX + userId) === "1";
  } catch {
    return false;
  }
}

export function markAsked(userId: string | null | undefined): void {
  if (!userId) return;
  try {
    sessionStorage.setItem(ASKED_KEY_PREFIX + userId, "1");
  } catch {
    /* without storage we may ask again on the next load; the browser still only prompts once */
  }
}

/** Opens the browser's own permission prompt. Resolves to where the browser ended up — including
 *  "default" when the viewer dismissed it without choosing. */
export async function requestAlertPermission(): Promise<AlertPermission> {
  if (!supported()) return "unsupported";
  try {
    // Older Safari passes the result to a callback and returns undefined.
    const result = await new Promise<NotificationPermission>((resolve) => {
      const maybe = window.Notification.requestPermission((p) => resolve(p));
      if (maybe && typeof maybe.then === "function") void maybe.then(resolve);
    });
    emit(); // every copy of the row on screen re-reads the answer
    return result === "granted" || result === "denied" ? result : "default";
  } catch {
    return alertPermission();
  }
}

/* --------------------------- click → the right page -------------------------- */

type ClickHandler = (n: AlertPayload) => void;
let onClick: ClickHandler | null = null;

/** Registered by useBrowserAlerts so a click can focus this tab and route to the notification's page.
 *  A module-level slot because the alert is raised from the store, which has no router. */
export function setAlertClickHandler(handler: ClickHandler | null): void {
  onClick = handler;
}

/** The tab's current icon — the brand's favicon under a white label, so the alert wears the brand. */
function alertIcon(): string | undefined {
  try {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    return link?.href || undefined;
  } catch {
    return undefined;
  }
}

/** Raises one system notification. Returns false when it couldn't be shown — the caller then falls
 *  back to the in-app toast, so a viewer is never left with no alert at all. */
export function showBrowserAlert(n: AlertPayload): boolean {
  if (!alertsEnabled()) return false;
  try {
    const alert = new window.Notification(n.title, {
      body: n.message || undefined,
      // One live alert per notification row: a re-delivery replaces it rather than stacking.
      tag: n.id,
      icon: alertIcon(),
    });
    alert.onclick = () => {
      try {
        window.focus();
      } catch {
        /* focus is best-effort; the click still routes below */
      }
      alert.close();
      onClick?.(n);
    };
    return true;
  } catch {
    // iOS Safari and some webviews report permission but refuse the constructor.
    return false;
  }
}
