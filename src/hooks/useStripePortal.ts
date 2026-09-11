import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";

/**
 * Opens Stripe's billing portal, exposing a `busy` flag for the trigger button.
 *
 * The subtlety this exists for: leaving via `location.assign` puts the page in
 * the browser's back/forward cache, so pressing Back restores this component
 * with `busy` still true and the button stuck on "Opening…" forever. `pageshow`
 * fires on that restore and `persisted` distinguishes it from a normal load.
 * Every portal button needs that reset, so it lives here rather than at each
 * call site.
 */
export function useStripePortal() {
  const [busy, setBusy] = useState(false);

  const open = useCallback(() => {
    setBusy(true);
    api.billing
      .portal()
      .then(({ url }) => window.location.assign(url))
      .catch((e) => {
        toast.error(e instanceof ApiError ? e.message : "Couldn't open billing portal");
        setBusy(false);
      });
  }, []);

  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) setBusy(false);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  return { open, busy };
}
