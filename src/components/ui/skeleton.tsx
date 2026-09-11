import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

/** Base shimmer block. Compose these into page-shaped skeletons below. */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />;
}

/** Title + subtitle placeholder for a page header. */
export function PageHeaderSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-4 w-72" />
    </div>
  );
}

/** A row of metric cards (icon + label + big number). */
export function StatCardsSkeleton({ count = 4, className }: { count?: number; className?: string }) {
  return (
    <div className={cn("grid gap-4 sm:grid-cols-2 lg:grid-cols-4", className)}>
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i}>
          <CardContent className="space-y-3 p-5">
            <div className="flex items-center justify-between">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="size-9 rounded-lg" />
            </div>
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-3 w-28" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** A card containing a header and N text-row placeholders. */
export function CardSkeleton({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader>
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-3.5 w-64" />
      </CardHeader>
      <CardContent className="space-y-3">
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </CardContent>
    </Card>
  );
}

/** A table-shaped skeleton inside a card (header strip + rows). */
export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex items-center gap-4 border-b border-border px-5 py-3.5">
          {Array.from({ length: cols }).map((_, i) => (
            <Skeleton key={i} className="h-3.5 flex-1" />
          ))}
        </div>
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="flex items-center gap-4 border-b border-border px-5 py-4 last:border-0">
            {Array.from({ length: cols }).map((_, c) => (
              <Skeleton key={c} className={cn("h-4 flex-1", c === 0 && "max-w-[80px]")} />
            ))}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/**
 * Full-page skeleton: header + optional stat cards + body. A sensible default
 * for any page that loads data — pass a `variant` to match the page shape.
 */
export function PageSkeleton({
  variant = "cards",
  stats = 4,
}: {
  variant?: "cards" | "table" | "form";
  stats?: number;
}) {
  return (
    <div className="space-y-6">
      <PageHeaderSkeleton />
      {variant === "table" && (
        <>
          <StatCardsSkeleton count={stats} />
          <TableSkeleton />
        </>
      )}
      {variant === "cards" && <StatCardsSkeleton count={stats} className="lg:grid-cols-3" />}
      {variant === "form" && <CardSkeleton rows={5} />}
      {variant === "cards" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <CardSkeleton />
          <CardSkeleton />
        </div>
      )}
    </div>
  );
}
