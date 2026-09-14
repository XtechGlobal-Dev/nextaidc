import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";

/** Opens Stripe's billing portal with a `busy` flag. Back from the portal restores the page from
 *  bfcache with `busy` still true, so `pageshow` (persisted) resets it — else the button sticks on "Opening…". */
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
