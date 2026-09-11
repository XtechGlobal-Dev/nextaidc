import { Activity, DollarSign, LayoutGrid, Plug, Settings2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/* ------------------------------------------------------------------ *
 *  The API Center's sections, declared once.
 *
 *  Five, not twelve. The earlier split gave every metric its own tab, which
 *  meant an operator had to know which of twelve screens held the number they
 *  wanted before they could look at it. Related concerns now share a page with a
 *  small view-switcher, so the navigation answers "what kind of question am I
 *  asking?" rather than "which metric is this?".
 *
 *  Nothing was dropped — health, quotas, keys, usage, latency, errors and logs
 *  all still exist, one level down instead of one tab across. Per-provider depth
 *  lives in the drawer, which is where detail belongs.
 *
 *  Both the sidebar group and the in-page rail render from this list, so they
 *  can never disagree about what exists or what order it's in.
 * ------------------------------------------------------------------ */

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
