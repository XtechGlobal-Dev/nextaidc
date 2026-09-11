import { Check, Circle, ListChecks } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { BrandReadiness } from "@/lib/api";

/**
 * What still stands between this brand and "finished", with a jump to the tab
 * that fixes each gap. Computed on the server (see brandReadiness in
 * brands.routes.ts) so the list is the same one the API acts on.
 */
export function BrandReadinessCard({
  readiness,
  onGo,
}: {
  readiness: BrandReadiness;
  onGo: (tab: string) => void;
}) {
  const missing = readiness.items.filter((i) => !i.done);
  const complete = missing.length === 0;

  return (
    <Card className="mb-5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ListChecks className="size-4 text-primary" />
          <h3 className="text-sm font-semibold">Setup</h3>
          <span className="text-xs text-muted-foreground">
            {readiness.done} of {readiness.total} done
          </span>
        </div>
        <Badge variant={complete ? "success" : "warning"}>
          {complete ? "Ready for customers" : `${missing.length} to go`}
        </Badge>
      </div>

      {!complete && (
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {readiness.items.map((item) => (
            <li
              key={item.id}
              className="flex items-start gap-2 rounded-lg border border-border px-3 py-2 text-xs"
            >
              {item.done ? (
                <Check className="mt-0.5 size-3.5 shrink-0 text-success" />
              ) : (
                <Circle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/50" />
              )}
              <div className="min-w-0 flex-1">
                <div className={item.done ? "text-muted-foreground line-through" : "font-medium"}>
                  {item.label}
                </div>
                {!item.done && (
                  <div className="mt-0.5 text-muted-foreground">
                    {item.hint}{" "}
                    <button
                      type="button"
                      onClick={() => onGo(item.tab)}
                      className="font-medium text-primary hover:underline"
                    >
                      Fix →
                    </button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
