import { Copy, Eye, Globe, MoreHorizontal, Phone, PhoneOff, SearchX } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  DataCard,
  DataCardAvatar,
  DataCardHeader,
  DataCardPills,
  DataCardGrid,
  CardField,
} from "@/components/ui/data-card";
import { Pagination } from "@/components/ui/pagination";
import { usePagination } from "@/hooks/usePagination";
import { useCallsStore } from "@/stores/useCallsStore";
import { cn, formatDate, formatDuration } from "@/lib/utils";
import type { CallLog } from "@/types";
import { OUTCOME_LABELS, outcomeVariant, transferBadge, intentBadge, callerLabel } from "./callUtils";

function transcriptToText(call: CallLog): string {
  const transcript = call.transcript ?? [];
  if (transcript.length === 0) return "No transcript available for this call.";
  return transcript
    .map((turn) => `[${formatDuration(turn.at)}] ${turn.role === "agent" ? "Agent" : "Caller"}: ${turn.text}`)
    .join("\n");
}

async function copyTranscript(call: CallLog) {
  // Archived calls come without a transcript — fetch first or the copy silently says "No transcript available".
  const full = (await useCallsStore.getState().ensureTranscript(call.id)) ?? call;
  const text = transcriptToText(full);
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Transcript copied to clipboard");
  } catch {
    toast.error("Couldn't copy transcript");
  }
}

export function CallTable({
  calls,
  selectedId,
  onSelect,
  filtersActive = false,
  onClearFilters,
}: {
  calls: CallLog[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** True when a search/outcome/date filter is narrowing the list. */
  filtersActive?: boolean;
  onClearFilters?: () => void;
}) {
  // `calls` arrives already filtered by the inbox; the hook only pages it.
  const { page, pageSize, pageItems: rows, total, setPage, setPageSize } = usePagination(calls);

  const initials = (name: string) => {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  };

  const typeBadge = (call: CallLog) => (
    <Badge variant={call.type === "Web" ? "primary" : "neutral"}>
      {call.type === "Web" ? <Globe className="size-3" /> : <Phone className="size-3" />}
      {call.type}
    </Badge>
  );

  /** Category → outcome → transfer, in the order the owner scans them: what the
   *  caller wanted, whether the call worked, and whether a handover failed. */
  const statusPills = (call: CallLog) => {
    const intent = intentBadge(call);
    const xfer = transferBadge(call);
    return (
      <>
        {intent && <Badge variant={intent.variant}>{intent.label}</Badge>}
        <Badge variant={outcomeVariant(call.outcome)}>{OUTCOME_LABELS[call.outcome]}</Badge>
        {xfer && <Badge variant={xfer.variant}>{xfer.label}</Badge>}
      </>
    );
  };

  const renderActions = (call: CallLog) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Row actions">
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => void copyTranscript(call)}>
          <Copy />
          Copy Transcript
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onSelect(call.id)}>
          <Eye />
          View Details
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const emptyState = (
    <div className="flex flex-col items-center gap-3 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        {filtersActive ? <SearchX className="size-6" /> : <PhoneOff className="size-6" />}
      </span>
      {filtersActive ? (
        <>
          <div>
            <p className="text-sm font-medium text-foreground">No calls match your filters</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Try widening the date range or clearing the outcome filter.
            </p>
          </div>
          {onClearFilters && (
            <Button variant="outline" size="sm" onClick={onClearFilters}>
              Clear filters
            </Button>
          )}
        </>
      ) : (
        <div>
          <p className="text-sm font-medium text-foreground">No calls yet</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Calls handled by your AI receptionist will show up here.
          </p>
        </div>
      )}
    </div>
  );

  return (
    <div>
      {/* Desktop — table */}
      <div className="hidden overflow-hidden rounded-[var(--radius-card)] border border-border bg-card shadow-[var(--shadow-soft)] md:block">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-warm text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Caller</th>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Duration</th>
              <th className="px-4 py-3">Outcome</th>
              <th className="px-4 py-3">Summary</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-14">{emptyState}</td>
              </tr>
            )}
            {rows.map((call) => (
              <tr
                key={call.id}
                onClick={() => onSelect(call.id)}
                className={cn(
                  "cursor-pointer border-b border-border transition-colors last:border-b-0 hover:bg-muted/40",
                  selectedId === call.id && "bg-primary-tint/40",
                )}
              >
                <td className="px-4 py-3">{typeBadge(call)}</td>
                <td className="px-4 py-3">
                  <div className="font-medium text-foreground">{callerLabel(call.callerName)}</div>
                  <div className="text-xs text-muted-foreground">{call.callerNumber}</div>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                  {formatDate(call.createdAt)}
                </td>
                <td className="px-4 py-3 tabular-nums text-muted-foreground">
                  {formatDuration(call.durationSec)}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-1.5">{statusPills(call)}</div>
                </td>
                <td className="max-w-[20rem] px-4 py-3">
                  <span className="line-clamp-1 text-muted-foreground">{call.summary}</span>
                </td>
                <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                  {renderActions(call)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </div>

      {/* Mobile — cards */}
      <div className="space-y-3 md:hidden">
        {rows.length === 0 ? (
          <div className="rounded-[var(--radius-card)] border border-border bg-card px-4 py-14 shadow-[var(--shadow-soft)]">
            {emptyState}
          </div>
        ) : (
          rows.map((call) => (
            <DataCard
              key={call.id}
              onClick={() => onSelect(call.id)}
              className={cn(selectedId === call.id && "border-primary/40 bg-primary-tint-soft")}
            >
              <DataCardHeader
                lead={<DataCardAvatar>{initials(callerLabel(call.callerName))}</DataCardAvatar>}
                title={callerLabel(call.callerName)}
                subtitle={call.callerNumber}
                actions={renderActions(call)}
              />
              <DataCardPills>
                {typeBadge(call)}
                {statusPills(call)}
              </DataCardPills>
              <DataCardGrid>
                <CardField label="Date">{formatDate(call.createdAt)}</CardField>
                <CardField label="Duration">
                  <span className="tabular-nums">{formatDuration(call.durationSec)}</span>
                </CardField>
                <div className="col-span-2 min-w-0">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Summary
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{call.summary}</p>
                </div>
              </DataCardGrid>
            </DataCard>
          ))
        )}
      </div>

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        noun="calls"
      />
    </div>
  );
}

export { copyTranscript, transcriptToText };
