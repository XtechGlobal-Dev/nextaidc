import { ArrowUpRight, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuthStore } from "@/stores/useAuthStore";

/** Shown on the platform's own domain to an account that now lives on its brand's address (an approved Brand Admin
 *  request). There's nothing to do here any more, so it can't be dismissed: Visit signs out of this domain and opens
 *  the brand's sign-in page. */
export function AccountMovedDialog({ origin, brandName }: { origin: string; brandName: string | null }) {
  const logout = useAuthStore((s) => s.logout);
  const host = origin.replace(/^https?:\/\//, "");

  const visit = () => {
    logout();
    window.location.assign(`${origin}/login`);
  };

  return (
    <Dialog open>
      <DialogContent hideClose onEscapeKeyDown={(e) => e.preventDefault()} onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <span className="mb-1 grid size-11 place-items-center rounded-xl bg-primary-tint text-primary">
            <Building2 className="size-5" />
          </span>
          <DialogTitle>{brandName ? `${brandName} has its own address now` : "Your account has moved"}</DialogTitle>
          <DialogDescription>
            Your account is now the Brand Admin at <strong className="text-foreground">{host}</strong>. Sign in there
            from now on, with the same email and password. You&rsquo;ll be signed out here.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button className="w-full sm:w-auto" onClick={visit}>
            Visit {host} <ArrowUpRight className="size-4" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
