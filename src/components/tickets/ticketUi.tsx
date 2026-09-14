import type { ComponentProps, ReactNode } from "react";
import {
  Building2,
  Check,
  CreditCard,
  FileText,
  KeyRound,
  MessageSquareText,
  Phone,
  Receipt,
  RefreshCw,
  Settings2,
  TrendingUp,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { Ticket, TicketPriority, TicketStatus } from "@/types/ticket";

// Shared ticket-state vocabulary. One deliberate split: "pending" reads as "waiting on you" to a
// requester and "waiting on them" to a handler.

/** Status as the REQUESTER reads it. */
export const STATUS_LABEL: Record<TicketStatus, string> = {
  open: "Open",
  pending: "Awaiting your reply",
  resolved: "Resolved",
  closed: "Closed",
};

/** Status as a HANDLER reads it. */
export const STATUS_LABEL_STAFF: Record<TicketStatus, string> = {
  open: "Open",
  pending: "Waiting on requester",
  resolved: "Resolved",
  closed: "Closed",
};

const STATUS_VARIANT: Record<TicketStatus, "primary" | "warning" | "success" | "neutral"> = {
  open: "primary",
  pending: "warning",
  resolved: "success",
  closed: "neutral",
};

export const PRIORITY_LABEL: Record<TicketPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

const PRIORITY_DOT: Record<TicketPriority, string> = {
  low: "bg-muted-foreground/50",
  normal: "bg-primary",
  high: "bg-warning",
  urgent: "bg-danger",
};

// Picker menus: each choice gets a tone and a one-line hint so the menu explains itself.

export const STATUS_TONE: Record<TicketStatus, { dot: string; tile: string }> = {
  open: { dot: "bg-primary", tile: "bg-primary-tint text-primary" },
  pending: { dot: "bg-warning", tile: "bg-warning-tint text-warning" },
  resolved: { dot: "bg-success", tile: "bg-success-tint text-success" },
  closed: { dot: "bg-muted-foreground", tile: "bg-muted text-muted-foreground" },
};

/** What each status means for the handler reading the menu. */
export const STATUS_HINT_STAFF: Record<TicketStatus, string> = {
  open: "The team owes a reply",
  pending: "Waiting on the requester",
  resolved: "Answered — they can rate it",
  closed: "Nothing more to do",
};

export const PRIORITY_TONE: Record<TicketPriority, { dot: string; tile: string }> = {
  low: { dot: "bg-muted-foreground/60", tile: "bg-muted text-muted-foreground" },
  normal: { dot: "bg-primary", tile: "bg-primary-tint text-primary" },
  high: { dot: "bg-warning", tile: "bg-warning-tint text-warning" },
  urgent: { dot: "bg-danger", tile: "bg-danger-tint text-danger" },
};

export const PRIORITY_HINT: Record<TicketPriority, string> = {
  low: "When there's time",
  normal: "The usual queue",
  high: "Ahead of the queue",
  urgent: "Drop everything",
};

/** The status control's wash in a list — the whole control takes the colour, so
 *  there is no pill sitting inside a bordered box. */
export const STATUS_WASH: Record<TicketStatus, string> = {
  open: "border-transparent bg-primary-tint hover:border-primary/30",
  pending: "border-transparent bg-warning-tint hover:border-warning/40",
  resolved: "border-transparent bg-success-tint hover:border-success/40",
  closed: "border-transparent bg-muted hover:border-border",
};

/** A small uppercase heading inside a dropdown. */
export function MenuTitle({ children }: { children: ReactNode }) {
  return (
    <p className="px-2.5 pb-1.5 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </p>
  );
}

/** A coloured dot for a MenuOption's tile. */
export function ToneDot({ className }: { className: string }) {
  return <span className={cn("size-2.5 rounded-full", className)} />;
}

/** One picker-menu choice: tinted tile, label, optional hint, check when current. Shared by every ticket menu. */
export function MenuOption({
  icon,
  tone,
  label,
  hint,
  selected = false,
  destructive = false,
  className,
  ...props
}: Omit<ComponentProps<typeof DropdownMenuItem>, "children"> & {
  icon: ReactNode;
  /** Tile classes — background and icon colour. */
  tone?: string;
  label: ReactNode;
  hint?: ReactNode;
  selected?: boolean;
  destructive?: boolean;
}) {
  return (
    <DropdownMenuItem
      className={cn(
        "items-center gap-3 rounded-lg px-2 py-2 focus:text-foreground",
        selected && "bg-primary-tint-soft",
        destructive && "text-danger focus:bg-danger-tint focus:text-danger",
        className,
      )}
      aria-current={selected ? "true" : undefined}
      {...props}
    >
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg",
          tone ?? "bg-muted text-muted-foreground",
          destructive && "bg-danger-tint text-danger",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium leading-tight">{label}</span>
        {hint && (
          <span className="mt-0.5 block truncate text-xs font-normal text-muted-foreground">
            {hint}
          </span>
        )}
      </span>
      {selected && <Check className="size-4 shrink-0 text-primary" />}
    </DropdownMenuItem>
  );
}

// Ticket row icon, picked from subject then department, so a glance separates money from login trouble.

const TILE_TONE = {
  blue: "border-primary/25 bg-primary-tint-soft text-primary",
  green: "border-success/30 bg-success-tint/50 text-success",
  violet: "border-violet-500/25 bg-violet-500/5 text-violet-600 dark:text-violet-400",
  orange: "border-orange-500/25 bg-orange-500/5 text-orange-600 dark:text-orange-400",
  grey: "border-border bg-muted/40 text-muted-foreground",
} as const;

const TILE_RULES: { match: RegExp; icon: LucideIcon; className: string }[] = [
  { match: /refund|chargeback|cancel/i, icon: RefreshCw, className: TILE_TONE.orange },
  { match: /invoice|receipt|payout|wallet/i, icon: FileText, className: TILE_TONE.green },
  { match: /payment|card|charge|paid/i, icon: CreditCard, className: TILE_TONE.green },
  { match: /bill|subscription|plan|pricing|upgrade/i, icon: Receipt, className: TILE_TONE.blue },
  {
    match: /login|log in|password|sign in|access|locked|2fa|otp/i,
    icon: KeyRound,
    className: TILE_TONE.violet,
  },
  { match: /call|phone|number|voice|dial/i, icon: Phone, className: TILE_TONE.green },
  { match: /sales|quote|demo/i, icon: TrendingUp, className: TILE_TONE.orange },
  { match: /brand|domain|white-?label|tenant/i, icon: Building2, className: TILE_TONE.violet },
  {
    match: /tech|integration|api|bug|error|setting|config/i,
    icon: Settings2,
    className: TILE_TONE.blue,
  },
];
const DEFAULT_TILE = { icon: MessageSquareText, className: TILE_TONE.grey };

export function ticketTile(t: Pick<Ticket, "subject" | "department">) {
  const hay = `${t.subject} ${t.department?.name ?? ""}`;
  return TILE_RULES.find((r) => r.match.test(hay)) ?? DEFAULT_TILE;
}

/** The tile itself, with the unread dot on its corner when there is something new. */
export function TicketTile({
  ticket,
  unread = false,
  className,
}: {
  ticket: Pick<Ticket, "subject" | "department">;
  unread?: boolean;
  className?: string;
}) {
  const tile = ticketTile(ticket);
  return (
    <span className={cn("relative shrink-0", className)}>
      <span
        className={cn("flex size-11 items-center justify-center rounded-xl border", tile.className)}
      >
        <tile.icon className="size-5" strokeWidth={1.75} />
      </span>
      {unread && (
        <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-primary ring-2 ring-card" />
      )}
    </span>
  );
}

export function TicketStatusBadge({
  status,
  staff = false,
  className,
}: {
  status: TicketStatus;
  staff?: boolean;
  className?: string;
}) {
  return (
    <Badge variant={STATUS_VARIANT[status]} className={className}>
      {(staff ? STATUS_LABEL_STAFF : STATUS_LABEL)[status]}
    </Badge>
  );
}

const STATUS_DOT: Record<TicketStatus, { dot: string; text: string }> = {
  open: { dot: "bg-primary", text: "text-primary" },
  pending: { dot: "bg-warning", text: "text-warning" },
  resolved: { dot: "bg-success", text: "text-success" },
  closed: { dot: "bg-muted-foreground", text: "text-muted-foreground" },
};

/** Status as dot + word, no pill, for bordered spots where a filled badge reads as a shape within a shape. */
export function TicketStatusDot({
  status,
  staff = false,
  className,
}: {
  status: TicketStatus;
  staff?: boolean;
  className?: string;
}) {
  const tone = STATUS_DOT[status];
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-xs font-medium", tone.text, className)}
    >
      <span className={cn("size-2 shrink-0 rounded-full", tone.dot)} />
      {(staff ? STATUS_LABEL_STAFF : STATUS_LABEL)[status]}
    </span>
  );
}

export function TicketPriorityBadge({
  priority,
  className,
}: {
  priority: TicketPriority;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground",
        className,
      )}
      title={`${PRIORITY_LABEL[priority]} priority`}
    >
      <span className={cn("size-2 rounded-full", PRIORITY_DOT[priority])} />
      {PRIORITY_LABEL[priority]}
    </span>
  );
}

/** Tenant badge. Renders only when there's a brand to name, so it's absent on a brand admin's own inbox. */
export function TicketBrandBadge({
  brand,
  className,
}: {
  brand: Ticket["brand"];
  className?: string;
}) {
  if (!brand) return null;
  return (
    <Badge
      variant="outline"
      className={cn("gap-1 border-border text-[11px] font-normal", className)}
      title={`Raised from ${brand.name}`}
    >
      <Building2 className="size-3" /> {brand.name}
    </Badge>
  );
}

/** "Micky Mouse" → "MM"; a lone word gives its first two letters. */
export function ticketInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const AVATAR_SIZE = {
  xs: "size-6 text-[10px]",
  sm: "size-9 text-xs",
  md: "size-10 text-sm",
  lg: "size-12 text-base",
} as const;

/** A handful of tints, so a list of people isn't a column of identical circles. */
const AVATAR_TONES = [
  "bg-primary-tint text-primary",
  "bg-success-tint text-success",
  "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  "bg-rose-500/10 text-rose-600 dark:text-rose-400",
] as const;

/** The same name always lands on the same tint — stable across renders and screens. */
function avatarTone(name: string): string {
  let h = 0;
  for (const ch of name.trim().toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length];
}

export function TicketAvatar({
  name,
  size = "md",
  className,
}: {
  name: string;
  size?: keyof typeof AVATAR_SIZE;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold",
        avatarTone(name),
        AVATAR_SIZE[size],
        className,
      )}
    >
      {ticketInitials(name)}
    </span>
  );
}

/** Live "245 / 1,000 characters" count; amber near the ceiling, red at it, so the limit isn't discovered by typing stopping. */
export function CharacterCount({
  value,
  max,
  className,
}: {
  value: number;
  max: number;
  className?: string;
}) {
  const atLimit = value >= max;
  const nearLimit = !atLimit && value >= max * 0.9;
  return (
    <span
      className={cn(
        "shrink-0 text-[11px] tabular-nums",
        atLimit ? "font-medium text-danger" : nearLimit ? "text-warning" : "text-muted-foreground",
        className,
      )}
      aria-live={atLimit ? "polite" : "off"}
    >
      {value.toLocaleString("en-US")} / {max.toLocaleString("en-US")} characters
    </span>
  );
}

/** Red unread marker. The pulse halo makes it findable in a long list; hidden under reduced motion. */
export function NewMessageDot({ inline = false, className }: { inline?: boolean; className?: string }) {
  return (
    <span
      role="img"
      aria-label="New message"
      title="New message"
      className={cn(
        "pointer-events-none",
        inline ? "relative inline-flex size-2.5 shrink-0" : "absolute -right-1 -top-1 flex size-3.5",
        className,
      )}
    >
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-danger/60 motion-reduce:hidden" />
      <span className="relative inline-flex size-full rounded-full bg-danger ring-2 ring-card" />
    </span>
  );
}
