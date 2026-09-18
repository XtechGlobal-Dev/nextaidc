import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  alertPermission,
  alertState,
  alertsEnabled,
  askedAlready,
  markAsked,
  requestAlertPermission,
  setAlertClickHandler,
  showBrowserAlert,
  subscribeAlertState,
} from "./browserNotifications";

// jsdom has no Notification, so each test installs the browser it wants to model.

interface FakeAlert {
  title: string;
  options: NotificationOptions;
  onclick: (() => void) | null;
  close: () => void;
}

const raised: FakeAlert[] = [];

/** Installs a Notification constructor at `permission`, or removes it to model a browser without one. */
function browserWith(permission: NotificationPermission | null, opts: { throws?: boolean } = {}) {
  if (permission === null) {
    delete (window as unknown as Record<string, unknown>).Notification;
    return;
  }
  function FakeNotification(this: FakeAlert, title: string, options: NotificationOptions = {}) {
    if (opts.throws) throw new TypeError("Illegal constructor");
    this.title = title;
    this.options = options;
    this.onclick = null;
    this.close = vi.fn();
    raised.push(this);
  }
  FakeNotification.permission = permission;
  FakeNotification.requestPermission = vi.fn();
  (window as unknown as Record<string, unknown>).Notification = FakeNotification;
}

const payload = { id: "n1", title: "New signup: Redtape", message: "Gaurav started a trial.", link: "/dashboard/calls" };

beforeEach(() => {
  raised.length = 0;
  localStorage.clear();
  sessionStorage.clear();
  setAlertClickHandler(null);
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).Notification;
});

describe("the browser's permission is the only gate", () => {
  it("raises an alert once the browser has granted", () => {
    browserWith("granted");
    expect(alertsEnabled()).toBe(true);
    expect(showBrowserAlert(payload)).toBe(true);
    expect(raised).toHaveLength(1);
    expect(raised[0].title).toBe(payload.title);
    expect(raised[0].options.body).toBe(payload.message);
    // Tagged by notification id, so a re-delivery of the same row replaces rather than stacks.
    expect(raised[0].options.tag).toBe("n1");
  });

  it("stays quiet when the browser has denied", () => {
    browserWith("denied");
    expect(alertPermission()).toBe("denied");
    expect(alertsEnabled()).toBe(false);
    expect(showBrowserAlert(payload)).toBe(false);
    expect(raised).toHaveLength(0);
  });

  it("stays quiet until the browser has been asked", () => {
    browserWith("default");
    expect(alertPermission()).toBe("default");
    expect(alertsEnabled()).toBe(false);
    expect(showBrowserAlert(payload)).toBe(false);
  });

  it("keeps nothing of its own in storage — granting is the whole opt-in", () => {
    browserWith("granted");
    expect(showBrowserAlert(payload)).toBe(true);
    // No in-app switch to fall out of step with the browser.
    expect(localStorage.length).toBe(0);
  });
});

describe("browsers that can't deliver", () => {
  it("reports unsupported and shows nothing where there is no Notification at all", () => {
    browserWith(null);
    expect(alertPermission()).toBe("unsupported");
    expect(alertsEnabled()).toBe(false);
    // False is the signal the store falls back to an in-app toast on.
    expect(showBrowserAlert(payload)).toBe(false);
  });

  it("falls back when the constructor throws despite reporting granted", () => {
    // iOS Safari and some webviews expose the name and permission, then refuse the call.
    browserWith("granted", { throws: true });
    expect(alertsEnabled()).toBe(true);
    expect(showBrowserAlert(payload)).toBe(false);
  });
});

describe("clicking an alert", () => {
  it("focuses this tab, closes the alert and hands the notification to the app", () => {
    browserWith("granted");
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    const onClick = vi.fn();
    setAlertClickHandler(onClick);

    showBrowserAlert(payload);
    raised[0].onclick?.();

    expect(focus).toHaveBeenCalled();
    expect(raised[0].close).toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledWith(payload);
    focus.mockRestore();
  });

  it("does not throw when nothing is registered to handle the click", () => {
    browserWith("granted");
    vi.spyOn(window, "focus").mockImplementation(() => {});
    showBrowserAlert(payload);
    expect(() => raised[0].onclick?.()).not.toThrow();
  });
});

describe("asking once per session", () => {
  it("remembers per account, so a reload doesn't re-prompt but another account still gets asked", () => {
    expect(askedAlready("u1")).toBe(false);
    markAsked("u1");
    expect(askedAlready("u1")).toBe(true);
    // A different account signing in here is a new session and gets its own ask.
    expect(askedAlready("u2")).toBe(false);
  });

  it("counts a signed-out visitor as already asked — there is nobody to ask for", () => {
    expect(askedAlready(null)).toBe(true);
    expect(askedAlready(undefined)).toBe(true);
  });
});

describe("the state the footer row renders", () => {
  it("says what to show for each answer the browser can give", () => {
    browserWith(null);
    expect(alertState()).toBe("unsupported");
    browserWith("denied");
    expect(alertState()).toBe("blocked");
    // Not asked yet — this is the one state that offers the Allow button.
    browserWith("default");
    expect(alertState()).toBe("ask");
    browserWith("granted");
    expect(alertState()).toBe("on");
  });

  it("tells every subscriber when the answer changes, so two copies can't disagree", async () => {
    browserWith("default");
    const panel = vi.fn();
    const page = vi.fn();
    const offPanel = subscribeAlertState(panel);
    const offPage = subscribeAlertState(page);

    // Allow: the browser answers, and both copies are told to re-read.
    (window.Notification.requestPermission as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        (window.Notification as unknown as { permission: string }).permission = "granted";
        return "granted";
      },
    );
    await requestAlertPermission();

    expect(panel).toHaveBeenCalledTimes(1);
    expect(page).toHaveBeenCalledTimes(1);
    expect(alertState()).toBe("on");

    offPanel();
    offPage();
  });
});
