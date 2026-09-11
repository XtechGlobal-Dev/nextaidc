import { useState } from "react";
import { useLocation } from "react-router-dom";
import { useAuthStore } from "@/stores/useAuthStore";
import { ImpersonationPinDialog } from "./ImpersonationPinDialog";
import { isAdminRole } from "@/lib/roles";

/** The customer whose detail page we're on, or null anywhere else. */
function customerIdFromPath(pathname: string): string | null {
  const m = /^\/dashboard\/admin\/customers\/([^/]+)\/?$/.exec(pathname);
  return m?.[1] ?? null;
}

/**
 * The 👋 in the header greeting — and, on an admin's customer detail page, the
 * way into "Login as Customer".
 *
 * There is no visible button for impersonation any more. It reads as an
 * ordinary decorative emoji, which is the intent: the capability should not
 * announce itself to anyone looking over an admin's shoulder or watching a
 * screen share.
 *
 * That concealment is worth EXACTLY nothing as security, and none is claimed
 * for it. `POST /customers/:id/impersonate` verifies a PIN server-side and
 * refuses without it; someone who found this trigger, or called the endpoint
 * directly, still cannot get in. This only decides who is *offered* the door.
 *
 * Everywhere else — every non-admin, and every other page — it renders as the
 * plain emoji it has always been, with no cursor change and nothing in the
 * accessibility tree to hint otherwise.
 */
export function ImpersonationEmojiTrigger() {
  const location = useLocation();
  const user = useAuthStore((s) => s.user);
  const impersonating = useAuthStore((s) => !!s.impersonator);
  const [open, setOpen] = useState(false);

  const customerId = customerIdFromPath(location.pathname);
  // Already wearing someone else's identity → nothing to start. The banner's
  // "Exit to admin" is the way back, and stacking a second impersonation on top
  // of the first would lose the original admin session held in the store.
  const armed = isAdminRole(user?.role) && !impersonating && !!customerId;

  if (!armed) return <span aria-hidden>👋</span>;

  return (
    <>
      <span
        role="button"
        tabIndex={-1}
        // No title, no aria-label, no hover styling: a tooltip reading "Login as
        // customer" would undo the entire point. tabIndex -1 keeps it out of the
        // tab order for the same reason — this is a deliberate secret, not a
        // control anyone is meant to discover by tabbing through the header.
        className="cursor-default select-none"
        onClick={() => setOpen(true)}
      >
        👋
      </span>
      {customerId && (
        <ImpersonationPinDialog open={open} onOpenChange={setOpen} customerId={customerId} />
      )}
    </>
  );
}
