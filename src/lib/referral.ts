/* Referral attribution — capture a reseller's ?ref=CODE at landing and
 * carry it through to sign-up so the customer is linked to the reseller. */

const REF_KEY = "hello22_ref";

/** Read ?ref=CODE from the current URL and persist it (called once on app load). */
export function captureReferralFromUrl() {
  try {
    const code = new URLSearchParams(window.location.search).get("ref");
    if (code && code.trim()) localStorage.setItem(REF_KEY, code.trim());
  } catch {
    /* ignore */
  }
}

export function getReferralCode(): string | undefined {
  return localStorage.getItem(REF_KEY) || undefined;
}

export function clearReferralCode() {
  localStorage.removeItem(REF_KEY);
}
