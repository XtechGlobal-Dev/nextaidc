import { useState } from "react";
import { ChevronDown, Columns3 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { SectionDef, CapabilityDef } from "@/lib/api";

/** Checked checkboxes render green (success) instead of the default primary. */
const GREEN_CHECK =
  "data-[state=checked]:border-success data-[state=checked]:bg-success data-[state=checked]:text-white";

/** Section (row-header) checkboxes render blue (brand primary) when checked. */
const BLUE_CHECK =
  "data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground";

/**
 * The permission matrix used to define a role: one row per admin section with
 * a checkbox per capability (View/Create/Edit/Delete). Sections that render a
 * data table expand to reveal column-level (`section.field.*`) sub-permissions
 * — allow-list semantics, so a role sees only the columns ticked here.
 */
export function PermissionSelector({
  sections,
  capabilities,
  value,
  onChange,
}: {
  sections: SectionDef[];
  capabilities: CapabilityDef[];
  value: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function mutate(fn: (next: Set<string>) => void) {
    const next = new Set(value);
    fn(next);
    onChange(next);
  }

  function toggle(key: string) {
    mutate((next) => (next.has(key) ? next.delete(key) : next.add(key)));
  }

  /** All keys a section owns — capabilities AND its column sub-permissions. */
  function sectionAllKeys(section: SectionDef): string[] {
    return [
      ...section.capabilities.map((c) => `${section.key}.${c}`),
      ...(section.fields ?? []).map((f) => `${section.key}.field.${f.key}`),
    ];
  }

  function toggleSection(section: SectionDef) {
    // Checking the section selects EVERYTHING it owns (capabilities + columns);
    // clicking again while anything is on clears it. Unchecking an individual
    // point only removes that one — the section stays checked while any remain.
    const keys = sectionAllKeys(section);
    const anyOn = keys.some((k) => value.has(k));
    mutate((next) => keys.forEach((k) => (anyOn ? next.delete(k) : next.add(k))));
  }

  function toggleAllColumns(section: SectionDef) {
    const keys = (section.fields ?? []).map((f) => `${section.key}.field.${f.key}`);
    const allOn = keys.every((k) => value.has(k));
    mutate((next) => keys.forEach((k) => (allOn ? next.delete(k) : next.add(k))));
  }

  function toggleExpand(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  const colSpan = 1 + capabilities.length;

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Section</th>
              {capabilities.map((c) => (
                <th key={c.key} className="px-3 py-2.5 text-center font-medium">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sections.map((s, i) => {
              // Checked when ANY owned point is on (capability OR column), not
              // only when all are.
              const anyChecked = sectionAllKeys(s).some((k) => value.has(k));
              const hasFields = (s.fields?.length ?? 0) > 0;
              const isOpen = expanded.has(s.key);
              const fieldKeys = (s.fields ?? []).map((f) => `${s.key}.field.${f.key}`);
              const activeCols = fieldKeys.filter((k) => value.has(k)).length;
              const zebra = i % 2 === 0 ? "" : "bg-muted/20";
              return (
                <>
                  <tr
                    key={s.key}
                    className={cn(
                      "border-b border-border/60 transition-colors hover:bg-muted/30",
                      !isOpen && "last:border-0",
                      zebra,
                    )}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <label className="flex cursor-pointer items-center gap-2.5 font-medium">
                          <Checkbox
                            checked={anyChecked}
                            onCheckedChange={() => toggleSection(s)}
                            className={BLUE_CHECK}
                          />
                          {s.label}
                        </label>
                        {hasFields && (
                          <button
                            type="button"
                            onClick={() => toggleExpand(s.key)}
                            className="ml-1 inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted"
                            title="Column visibility"
                          >
                            <Columns3 className="size-3" />
                            {activeCols}/{fieldKeys.length}
                            <ChevronDown
                              className={cn("size-3 transition-transform", isOpen && "rotate-180")}
                            />
                          </button>
                        )}
                      </div>
                    </td>
                    {capabilities.map((c) => {
                      const supported = s.capabilities.includes(c.key);
                      const permKey = `${s.key}.${c.key}`;
                      return (
                        <td key={c.key} className="px-3 py-3 text-center">
                          {supported ? (
                            <Checkbox
                              checked={value.has(permKey)}
                              onCheckedChange={() => toggle(permKey)}
                              className={GREEN_CHECK}
                            />
                          ) : (
                            <span className="text-muted-foreground/30">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                  {hasFields && isOpen && (
                    <tr key={`${s.key}-cols`} className={cn("border-b border-border/60 last:border-0", zebra)}>
                      <td colSpan={colSpan} className="px-4 pb-4 pt-1">
                        <div className="ml-7 rounded-lg border border-dashed border-border bg-background/60 p-3">
                          <div className="mb-2 flex items-center justify-between">
                            <p className="text-xs font-medium text-muted-foreground">
                              Columns visible in the {s.label} table
                            </p>
                            <button
                              type="button"
                              onClick={() => toggleAllColumns(s)}
                              className="text-xs font-medium text-primary hover:underline"
                            >
                              {fieldKeys.every((k) => value.has(k)) ? "Clear all" : "Select all"}
                            </button>
                          </div>
                          <div className="flex flex-wrap gap-x-5 gap-y-2">
                            {s.fields!.map((f) => {
                              const key = `${s.key}.field.${f.key}`;
                              return (
                                <label
                                  key={key}
                                  className="flex cursor-pointer items-center gap-2 text-sm"
                                >
                                  <Checkbox
                                    checked={value.has(key)}
                                    onCheckedChange={() => toggle(key)}
                                    className={GREEN_CHECK}
                                  />
                                  {f.label}
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
