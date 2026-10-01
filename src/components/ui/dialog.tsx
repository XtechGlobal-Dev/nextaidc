import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn("fixed inset-0 z-50 bg-foreground/40 backdrop-blur-sm", className)}
    {...props}
  />
));
DialogOverlay.displayName = "DialogOverlay";

/**
 * While a Select (or another Radix popper-based overlay) is open above this dialog, Radix disables
 * `pointer-events` on everything below the open popup EXCEPT the popup's own content — including this
 * dialog's own content. So the very next click, wherever it visually lands inside the dialog, doesn't
 * reach the dialog at all: it passes straight through to the overlay behind it, which reads as a
 * genuine click outside the dialog and closes it along with the dropdown. The event's `target` is
 * useless here — it's the overlay, not anything related to the popper.
 *
 * The only reliable signal is "was a popper open at the moment this pointerdown started" — and that has
 * to be captured as early as possible. The popper's OWN dismissal (also triggered by this same
 * pointerdown) runs in the bubble phase and unmounts it, same as this dialog's; by the time either
 * dialog's bubble-phase outside-handler asks, the popper may already be gone. The capture phase runs
 * before any bubble-phase handler gets a chance to unmount anything, so a single document-level capture
 * listener — set up once — records the answer while it's still true. Every Radix popper-based overlay
 * (Select, DropdownMenu, Popover, …) marks its portaled content the same way, so one check covers all
 * of them, for every dialog on the page.
 */
let popperWasOpenAtPointerDown = false;
if (typeof document !== "undefined") {
  document.addEventListener(
    "pointerdown",
    () => {
      popperWasOpenAtPointerDown = !!document.querySelector("[data-radix-popper-content-wrapper]");
    },
    true,
  );
}

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    hideClose?: boolean;
    /** Extra classes for the backdrop — e.g. a higher z-index when this dialog
     *  must sit ABOVE another modal (both overlay and content need lifting). */
    overlayClassName?: string;
  }
>(({ className, children, hideClose, overlayClassName, onPointerDownOutside, onInteractOutside, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogOverlay className={overlayClassName} />
    <DialogPrimitive.Content
      ref={ref}
      onPointerDownOutside={(e) => {
        if (popperWasOpenAtPointerDown) e.preventDefault();
        else onPointerDownOutside?.(e);
      }}
      onInteractOutside={(e) => {
        if (popperWasOpenAtPointerDown) e.preventDefault();
        else onInteractOutside?.(e);
      }}
      className={cn(
        // Mobile: bottom sheet — anchored to the bottom edge, full width, rounded
        // top, slides up like a native mobile app modal.
        "fixed inset-x-0 bottom-0 z-50 grid max-h-[92dvh] w-full gap-4 overflow-y-auto",
        "rounded-t-[var(--radius-card)] border border-border bg-background p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] shadow-[var(--shadow-panel)]",
        "animate-sheet-up",
        // sm+: revert to a centered dialog.
        "sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:max-h-[85vh] sm:w-[calc(100%-2rem)] sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[var(--radius-card)] sm:pb-6 sm:animate-none",
        className,
      )}
      {...props}
    >
      {/* Drag handle — bottom-sheet affordance, mobile only. */}
      <div
        aria-hidden
        className="mx-auto -mt-2 mb-1 h-1.5 w-10 shrink-0 rounded-full bg-border sm:hidden"
      />
      {children}
      {!hideClose && (
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-md p-1 text-muted-foreground hover:bg-muted">
          <X className="size-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
DialogContent.displayName = "DialogContent";

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1.5", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("text-lg font-semibold", className)} {...props} />
));
DialogTitle.displayName = "DialogTitle";

export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = "DialogDescription";
