import { Activity, DollarSign, LayoutGrid, Plug, Settings2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";

// API Center sections, declared once so the sidebar group and in-page rail can't disagree.
// Five pages with view-switchers rather than one tab per metric.

export interface ApiCenterSection {
  /** Path segment under /dashboard/admin/api-center. "" is the index route. */
  slug: string;
  label: string;
  icon: LucideIcon;
  /** One line explaining what the section answers — used as the page subtitle. */
  blurb: string;
}

export const API_CENTER_BASE = "/dashboard/admin/api-center";

export const API_CENTER_SECTIONS: ApiCenterSection[] = [
  {
    slug: "",
    label: "Overview",
    icon: LayoutGrid,
    blurb: "Is anything wrong, and what needs you first.",
  },
  {
    slug: "providers",
    label: "Providers",
    icon: Plug,
    blurb: "Every integration — status, traffic, quota and credentials.",
  },
  {
    slug: "activity",
    label: "Activity",
    icon: Activity,
    blurb: "Traffic, response times, failures and the raw request log.",
  },
  {
    slug: "costs",
    label: "Costs",
    icon: DollarSign,
    blurb: "Estimated spend by provider and category.",
  },
  {
    slug: "settings",
    label: "Settings",
    icon: Settings2,
    blurb: "Quotas, unit prices, environments and alert rules.",
  },
];

/** Absolute route for a section slug. */
export function sectionPath(slug: string): string {
  return slug ? `${API_CENTER_BASE}/${slug}` : API_CENTER_BASE;
}
