import type { Brand } from "@/lib/api";

// One place for how a brand's lifecycle reads on the list and detail pages.

type Variant = "success" | "warning" | "danger" | "neutral";

export function brandStatusVariant(b: Pick<Brand, "status">): Variant {
  switch (b.status) {
    case "active":
      return "success";
    case "provisioning":
      return "warning";
    case "failed":
    case "deactivated":
      return "danger";
    default:
      return "neutral";
  }
}

export function brandStatusLabel(b: Pick<Brand, "status" | "deletesAt">): string {
  switch (b.status) {
    case "active":
      return "Active";
    case "provisioning":
      return "Setting up";
    case "failed":
      return "Setup failed";
    case "deactivated":
      return b.deletesAt ? `Deactivated · deletes ${formatDeletesAt(b.deletesAt)}` : "Deactivated";
    default:
      return "Suspended";
  }
}

/** "Oct 16, 2026" — the day the sweep deletes a deactivated brand for good. */
export function formatDeletesAt(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
