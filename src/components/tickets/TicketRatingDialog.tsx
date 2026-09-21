import { useEffect, useState } from "react";
import { Loader2, Star } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { StarRating } from "@/components/tickets/StarRating";
import { cn } from "@/lib/utils";
import { MAX_STARS, POOR_RATING_MAX, type Ticket } from "@/types/ticket";

// Rating dialog, deliberately outside the conversation pane; opened from a header star or the "resolved" notification.

/** What each score is called, so the number isn't the only feedback. */
const STAR_LABEL: Record<number, string> = {
  1: "Not helpful at all",
  2: "Not very helpful",
  3: "It was okay",
  4: "Helpful",
  5: "Very helpful",
};

export interface TicketRatingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ticket: Ticket;
  /** Persist the score. Throwing keeps the dialog open with the message shown. */
  onRate: (stars: number, comment: string) => Promise<void>;
}

export function TicketRatingDialog({
  open,
  onOpenChange,
  ticket,
  onRate,
}: TicketRatingDialogProps) {
  const [stars, setStars] = useState<number | null>(ticket.rating);
  const [comment, setComment] = useState(ticket.ratingComment ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed each time it opens, so re-opening after a save shows what was saved
  // rather than a half-finished edit from last time.
  useEffect(() => {
    if (!open) return;
    setStars(ticket.rating);
    setComment(ticket.ratingComment ?? "");
    setError(null);
  }, [open, ticket.id, ticket.rating, ticket.ratingComment]);

  async function submit() {
    if (!stars) {
      setError("Pick a star rating first.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onRate(stars, comment);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save your rating.");
    } finally {
      setSaving(false);
    }
  }

  const poor = stars !== null && stars <= POOR_RATING_MAX;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>How did we do?</DialogTitle>
          <DialogDescription>
            Your feedback on <span className="font-medium text-foreground">{ticket.subject}</span>{" "}
            goes straight to the team that handled it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-2 py-2">
          <StarRating value={stars} onChange={setStars} size="lg" disabled={saving} />
          <p
            className={cn(
              "h-5 text-sm font-medium",
              stars === null && "text-muted-foreground",
              poor && "text-warning",
            )}
          >
            {stars === null ? "Tap a star to rate" : STAR_LABEL[stars]}
          </p>
        </div>

        <div className="space-y-2">
          <label htmlFor="rating-note" className="text-sm font-medium">
            Add a note <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <textarea
            id="rating-note"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            maxLength={1000}
            placeholder={
              poor
                ? "What went wrong, or what would have helped?"
                : "Anything that worked especially well?"
            }
            className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm leading-relaxed outline-none placeholder:text-muted-foreground focus:border-primary/60"
          />
          {poor && (
            <p className="text-xs text-muted-foreground">
              A low score is emailed to the team so someone takes another look.
            </p>
          )}
        </div>

        {error && <p className="text-xs text-danger">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {ticket.rating ? "Close" : "Not now"}
          </Button>
          <Button onClick={() => void submit()} disabled={saving || stars === null}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Star className="size-4" />}
            {ticket.rating ? "Update rating" : "Send rating"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Header star: shows the score once given; a pulsing dot marks the unanswered case so it reads as an invite. */
export function TicketRatingButton({
  ticket,
  onClick,
  className,
}: {
  ticket: Ticket;
  onClick: () => void;
  className?: string;
}) {
  if (!ticket.rateable) return null;
  const rated = ticket.rating !== null;

  return (
    <button
      type="button"
      onClick={onClick}
      title={rated ? `You rated this ${ticket.rating}/${MAX_STARS}` : "Rate this request"}
      aria-label={
        rated
          ? `Rated ${ticket.rating} of ${MAX_STARS}. Change your rating`
          : "Rate this request"
      }
      className={cn(
        "relative inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
        rated
          ? "border-warning/40 bg-warning-tint text-warning hover:bg-warning-tint/70"
          : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
        className,
      )}
    >
      <Star className={cn("size-3.5", rated && "fill-warning")} />
      {rated ? ticket.rating : "Rate"}
      {!rated && (
        <span className="absolute -right-0.5 -top-0.5 flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60 motion-reduce:hidden" />
          <span className="relative inline-flex size-2 rounded-full bg-primary" />
        </span>
      )}
    </button>
  );
}
