import { LayoutDashboard, Phone, PhoneCall, Settings } from "lucide-react";
import { env } from "@/lib/env";

/** Mock dashboard for the onboarding Launch step. Pure CSS/SVG so it stays crisp at any size. */
export function DashboardPreview() {
  return (
    <div className="overflow-hidden rounded-[var(--radius-card)] border border-border bg-card shadow-[var(--shadow-soft)]">
      {/* Window chrome */}
      <div className="flex items-center gap-1.5 border-b border-border bg-muted/60 px-3 py-2">
        <span className="size-2.5 rounded-full bg-[#FF5F57]" />
        <span className="size-2.5 rounded-full bg-[#FEBC2E]" />
        <span className="size-2.5 rounded-full bg-[#28C840]" />
        <span className="ml-2 inline-flex items-center gap-1.5 rounded-md bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          <PhoneCall className="size-3 text-primary" /> {env.appName} / dashboard
        </span>
      </div>

      <div className="flex">
        {/* Sidebar */}
        <aside className="hidden w-28 shrink-0 flex-col gap-1 border-r border-border bg-muted/40 p-3 sm:flex">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold">
            <span className="flex size-5 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <PhoneCall className="size-3" />
            </span>
            {env.appName}
          </div>
          {[
            { icon: LayoutDashboard, label: "Dashboard", active: true },
            { icon: Phone, label: "Call Logs" },
            { icon: PhoneCall, label: "Assistant" },
            { icon: Settings, label: "Settings" },
          ].map(({ icon: Icon, label, active }) => (
            <span
              key={label}
              className={
                "flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[10px] font-medium " +
                (active ? "bg-primary-tint text-primary" : "text-muted-foreground")
              }
            >
              <Icon className="size-3" /> {label}
            </span>
          ))}
        </aside>

        {/* Main panel */}
        <div className="flex-1 space-y-3 p-3.5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[11px] font-bold leading-none">Test Business</p>
              <p className="mt-1 text-[9px] text-muted-foreground">Primary AI Reception Line</p>
            </div>
            <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[9px] font-semibold text-success">
              <span className="size-1.5 rounded-full bg-success" /> Live
            </span>
          </div>

          <div className="grid grid-cols-[1.4fr_1fr] gap-3">
            {/* Bar chart card */}
            <div className="rounded-lg border border-border bg-background p-2.5">
              <p className="text-[9px] font-medium text-muted-foreground">Calling Minutes Used</p>
              <p className="text-lg font-bold leading-tight">2.93</p>
              <svg viewBox="0 0 120 40" className="mt-1 w-full" preserveAspectRatio="none">
                {[10, 16, 8, 24, 14, 30, 20].map((h, i) => (
                  <rect
                    key={i}
                    x={i * 17 + 2}
                    y={40 - h}
                    width="11"
                    height={h}
                    rx="2"
                    className="fill-primary"
                    opacity={0.55 + (h / 30) * 0.45}
                  />
                ))}
              </svg>
            </div>

            {/* Donut card */}
            <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-background p-2.5">
              <p className="self-start text-[9px] font-medium text-muted-foreground">Number of Calls</p>
              <div className="relative mt-1 grid place-items-center">
                <svg viewBox="0 0 36 36" className="size-14 -rotate-90">
                  <circle cx="18" cy="18" r="15.5" fill="none" strokeWidth="4" className="stroke-border" />
                  <circle
                    cx="18"
                    cy="18"
                    r="15.5"
                    fill="none"
                    strokeWidth="4"
                    strokeLinecap="round"
                    strokeDasharray="72 100"
                    className="stroke-success"
                  />
                </svg>
                <span className="absolute text-sm font-bold">5</span>
              </div>
            </div>
          </div>

          {/* Mini call-log rows */}
          <div className="space-y-1.5">
            {[68, 52, 60].map((w, i) => (
              <div key={i} className="flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5">
                <span className="size-4 shrink-0 rounded-full bg-primary-tint" />
                <span className="h-1.5 rounded-full bg-muted" style={{ width: `${w}%` }} />
                <span className="ml-auto h-1.5 w-6 rounded-full bg-success/40" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
