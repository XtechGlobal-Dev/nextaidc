import type { ReactNode } from "react";
import type { SectionMeta } from "./sectionMeta";

/** Consistent header for each numbered, color-coded AI Brain section. */
export function SectionShell({
  meta,
  children,
}: {
  meta: SectionMeta;
  children: ReactNode;
}) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div
          className="flex size-9 items-center justify-center rounded-xl text-sm font-bold text-white"
          style={{ backgroundColor: `var(${meta.colorVar})` }}
        >
          {meta.index}
        </div>
        <div>
          <h2 className="text-lg font-semibold leading-tight">{meta.label}</h2>
          <p className="text-sm text-muted-foreground">{meta.blurb}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

/** A titled sub-block within a section. */
export function FieldGroup({
  title,
  description,
  children,
  action,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-[var(--radius-card)] border border-border bg-card p-5 shadow-[var(--shadow-soft)]">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="font-semibold">{title}</h3>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}
