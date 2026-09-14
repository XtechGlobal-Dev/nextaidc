import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api, ApiError, setToken, getToken, markSessionActive, TOKEN_KEY, type AuthUser } from "@/lib/api";
import { getReferralCode, clearReferralCode } from "@/lib/referral";
import { resetUserStores } from "@/lib/resetUserStores";
import { trackEvent, hashUserData } from "@/lib/analytics";
import { isAdminRole, isAdminTeamRole, isSuperAdminRole } from "@/lib/roles";

interface AuthState {
  user: AuthUser | null;
  status: "idle" | "loading" | "authed" | "anon";
  /** Set when an admin suspension ended the session so the login page can say so. Cleared
   *  on a successful login or a normal logout. */
  suspendedNotice: boolean;
  /** Set while an admin is viewing a customer's panel — holds the admin session to restore on exit. */
  impersonator: { token: string; user: AuthUser } | null;
  /** Enter a customer's panel with a freshly-minted session (admin → customer). */
  startImpersonation: (token: string, user: AuthUser) => void;
  /** Leave the customer panel and restore the admin session. */
  stopImpersonation: () => void;
  login: (email: string, password: string) => Promise<void>;
  register: (data: { email: string; password: string; fullName: string; businessName?: string }) => Promise<void>;
  registerStart: (data: { email: string; password: string; fullName: string; businessName?: string; mobile?: string; businessNumber?: string; address?: string; viaOnboarding?: boolean }) => Promise<void>;
  registerVerify: (email: string, code: string) => Promise<void>;
  resendSignupOtp: (email: string) => Promise<void>;
  forgotPassword: (email: string) => Promise<void>;
  resetPassword: (email: string, code: string, newPassword: string) => Promise<void>;
  logout: () => void;
  /** Patch the cached auth user in place (e.g. when the profile form saves a new
   *  name) so the header greeting/chip stay in sync without a full reload. */
  patchUser: (patch: Partial<AuthUser>) => void;
  loadMe: () => Promise<void>;
  /** Force-logout because an admin suspended the account, then surface the notice
   *  on the login screen. Safe to call from a render effect. */
  forceSuspendLogout: () => void;
  /** Clear the suspended notice once the login page has consumed it. */
  clearSuspendedNotice: () => void;
  isAdmin: () => boolean;
  isAdminOrStaff: () => boolean;
  /** The platform owner — gates Brands, Platform Settings and the API Center. */
  isSuperAdmin: () => boolean;
  hasPermission: (perm: string) => boolean;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      status: "idle",
      suspendedNotice: false,
      impersonator: null,

      startImpersonation: (token, user) => {
        const currentToken = getToken();
        const admin = get().user;
        // Stash the admin's own session so "Exit" can restore it. Don't nest:
        // if we're somehow already impersonating, keep the original admin.
        if (currentToken && admin && !get().impersonator) {
          set({ impersonator: { token: currentToken, user: admin } });
        }
        setToken(token);
        set({ user, status: "authed" });
        // Switching into the customer's panel — clear the admin's cached data so
        // the customer's profile/agent/etc. loads fresh (and vice-versa on exit).
        resetUserStores();
      },

      stopImpersonation: () => {
        const imp = get().impersonator;
        if (!imp) return;
        setToken(imp.token);
        set({ user: imp.user, impersonator: null, status: "authed" });
        resetUserStores();
      },

      login: async (email, password) => {
        const { token, user } = await api.auth.login({ email, password });
        // Wipe the previous account's stores before the new user hydrates — shared
        // browsers must never leak one user's data to another. Also re-surfaces quick setup.
        resetUserStores();
        setToken(token);
        set({ user, status: "authed", suspendedNotice: false });
      },

      register: async (data) => {
        const { token, user } = await api.auth.register({ ...data, referralCode: getReferralCode() });
        clearReferralCode();
        setToken(token);
        set({ user, status: "authed" });
      },

      registerStart: async (data) => {
        await api.auth.registerStart({ ...data, referralCode: getReferralCode() });
      },

      registerVerify: async (email, code) => {
        const { token, user } = await api.auth.registerVerify({ email, code });
        clearReferralCode();
        setToken(token);
        set({ user, status: "authed" });
        // `sign_up` conversion fires only here (every signup path lands on OTP verify) and only
        // on success — never for a bad OTP, a login, or a password reset. `user_data` is PII for
        // GTM Enhanced Conversions (hashed on Google's side) — never map it to plain GA4 params; no password.
        try {
          const userData = {
            name: user.fullName || "",
            email: user.email || "",
            phone: user.profile?.mobile || "",
            business_number: user.profile?.businessNumber || "",
            address: user.profile?.address || "",
          };
          // Pre-hashed copy so raw PII never leaves the browser in the clear.
          const userDataHashed = await hashUserData(userData);
          trackEvent("sign_up", {
            method: "email_otp",
            // The account id — a non-PII identifier for GA4's User-ID / user-level
            // tracking. Top-level so GTM can map it straight to `user_id`.
            user_id: user.id,
            user_data: userData,
            user_data_hashed: userDataHashed,
          });
        } catch {
          /* ignore — signup already succeeded */
        }
      },

      resendSignupOtp: async (email) => {
        await api.auth.registerResend(email);
      },

      forgotPassword: async (email) => {
        await api.auth.forgotPassword(email);
      },

      resetPassword: async (email, code, newPassword) => {
        const { token, user } = await api.auth.resetPassword({ email, code, newPassword });
        setToken(token);
        set({ user, status: "authed" });
      },

      logout: () => {
        setToken(null);
        set({ user: null, status: "anon", suspendedNotice: false, impersonator: null });
        // Wipe every user-scoped store so the next account starts clean.
        resetUserStores();
      },

      forceSuspendLogout: () => {
        if (get().suspendedNotice && get().status === "anon") return; // already done
        setToken(null);
        set({ user: null, status: "anon", suspendedNotice: true, impersonator: null });
        resetUserStores();
      },

      clearSuspendedNotice: () => set({ suspendedNotice: false }),

      patchUser: (patch) => set((s) => (s.user ? { user: { ...s.user, ...patch } } : s)),

      loadMe: async () => {
        if (!getToken()) {
          set({ user: null, status: "anon" });
          return;
        }
        // If we have a cached user (restored from localStorage), treat the
        // session as authed immediately so a reload/HMR doesn't flash login.
        set({ status: get().user ? "authed" : "loading" });
        try {
          const { user } = await api.auth.me();
          set({ user, status: "authed" });
        } catch (e) {
          // The admin suspended this account → hard-logout with the suspended notice.
          if (e instanceof ApiError && e.status === 403 && e.details === "account_suspended") {
            get().forceSuspendLogout();
          } else if (e instanceof ApiError && e.status === 401) {
            // Only a real 401 means the session is invalid → log out.
            setToken(null);
            set({ user: null, status: "anon" });
          } else if (!get().user) {
            // Couldn't reach the API and we have nothing cached.
            set({ status: "anon" });
          } else {
            // API down/restarting (dev) — keep the cached session.
            set({ status: "authed" });
          }
        }
      },

      isAdmin: () => isAdminRole(get().user?.role),
      isAdminOrStaff: () => isAdminTeamRole(get().user?.role),
      isSuperAdmin: () => isSuperAdminRole(get().user?.role),
      hasPermission: (perm: string) => {
        const u = get().user;
        if (!u) return false;
        if (isAdminRole(u.role)) return true;
        if (u.role !== "STAFF") return false;
        const key = perm.includes(".") ? perm : `${perm}.view`;
        return u.permissions.includes(key);
      },
    }),
    {
      name: "hello22_auth",
      // Persist the user + any active impersonation so a reload keeps the
      // "viewing as" session (status is derived on load via loadMe()).
      partialize: (s) => ({ user: s.user, impersonator: s.impersonator }),
    },
  ),
);

// Keep the api layer's session flag in sync with our auth status, so a 401 can
// force a logout even after this tab's token was cleared elsewhere.
markSessionActive(useAuthStore.getState().status === "authed");
useAuthStore.subscribe((s) => markSessionActive(s.status === "authed"));

// Cross-tab logout: without this, other tabs keep showing the dashboard while their API
// calls silently 401 — RequireAuth only redirects once status flips to "anon".
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === TOKEN_KEY && e.newValue === null) {
      if (useAuthStore.getState().status !== "anon") useAuthStore.getState().logout();
    }
  });
}
