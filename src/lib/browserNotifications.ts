// System notifications for in-app notifications: the same rows the bell lists, delivered by the
// browser so they land even when the tab is in the background.
//
// Two gates, and both must be open: the browser's permission for this site, and the viewer's own
// switch in the notification panel. The browser's permission can only be granted here — revoking it
// is a site-settings job — so the in-app switch is what lets someone turn alerts off again without
// digging through browser settings. It defaults to on: granting permission is the opt-in.
//
// Every browser call here is wrapped: iOS Safari has no Notification constructor, a private window
// can throw on storage, and an embedded webview may expose the name but refuse the call.

export type AlertPermission = "unsupported" | "default" | "granted" | "denied";

/** Per-tab marker that this account has already been asked, so a reload doesn't nag. */
const ASKED_KEY_PREFIX = "notifications.browserAlerts.asked.";

/** The viewer's own switch. Per browser, like the permission it sits behind. Absent means on. */
const PREF_KEY = "notifications.browserAlerts.enabled";

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

/** The viewer's in-app switch. On unless they turned it off; storage failures read as on so a private
 *  window still delivers once the browser has granted. */
export function alertsPreferred(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Flips the in-app switch. Never touches the browser's permission — that stays granted, so turning
 *  alerts back on later needs no second prompt. */
export function setAlertsPreferred(on: boolean): void {
  try {
    if (on) localStorage.removeItem(PREF_KEY);
    else localStorage.setItem(PREF_KEY, "0");
  } catch {
    /* without storage the switch can't be remembered; the row re-reads and shows the truth */
  }
  emit();
}

/** Whether a notification raised now would actually reach the desktop: the browser has granted and
 *  the viewer hasn't switched alerts off. */
export function alertsEnabled(): boolean {
  return alertPermission() === "granted" && alertsPreferred();
}

/* --------------------------- what the footer row shows -------------------------- */

/**  ask — the browser hasn't been asked yet; switching on opens its prompt
 *  on — granted and switched on; alerts are being delivered
 *  off — granted, but the viewer switched alerts off here; switching on needs no new prompt
 *  blocked — the viewer said no, or the browser did; only site settings can undo it
 *  unsupported — this browser has no notifications at all */
export type AlertState = "ask" | "on" | "off" | "blocked" | "unsupported";

/** Read fresh every time: the permission is the browser's to change, from its own site settings. */
export function alertState(): AlertState {
  const permission = alertPermission();
  if (permission === "unsupported") return "unsupported";
  if (permission === "denied") return "blocked";
  if (permission === "granted") return alertsPreferred() ? "on" : "off";
  return "ask";
}

const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/** Subscribes to every way the state can change: this tab asking for permission or flipping the
 *  switch, the browser's own site settings, or another tab flipping the switch. One shared source,
 *  so two copies of the row on screen can never disagree. */
export function subscribeAlertState(onChange: () => void): () => void {
  listeners.add(onChange);
  const cleanups: (() => void)[] = [() => listeners.delete(onChange)];

  // Coming back to the tab is the moment a change made in site settings becomes visible.
  const onVisible = () => onChange();
  document.addEventListener("visibilitychange", onVisible);
  cleanups.push(() => {
    document.removeEventListener("visibilitychange", onVisible);
  });

  // The switch is shared across tabs; a flip elsewhere shows up here.
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === PREF_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  cleanups.push(() => {
    window.removeEventListener("storage", onStorage);
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
export function alertIcon(): string | undefined {
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
