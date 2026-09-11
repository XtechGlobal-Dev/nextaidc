import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge conditional class names, de-duplicating Tailwind conflicts. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format seconds as m:ss (e.g. 135 -> "2:15"). */
export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Format an ISO date as a short, locale-friendly string. */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-AU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** The app-wide plain-date format: dd/mm/yyyy. Never the ambiguous US m/d/yyyy —
 *  use this (not a bare toLocaleDateString / en-US) wherever a date is shown. */
export function formatDateDMY(value: string | number | Date | null | undefined): string {
  if (value == null || value === "") return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/** Relative "x min ago" style time. */
export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days > 1 ? "s" : ""} ago`;
}

/** Uppercase the first letter of a status/label (e.g. "active" -> "Active"). */
export function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/**
 * Title-case a person's name for display (e.g. "redtape" -> "Redtape",
 * "john doe" -> "John Doe"). Only the first letter of each word is forced up —
 * the rest is left untouched so intentional caps (e.g. "McCoy") survive.
 */
export function titleCaseName(value: string): string {
  return value
    .split(/\s+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Mask a phone number, keeping the last few digits. */
export function maskPhone(num: string): string {
  const digits = num.replace(/\D/g, "");
  if (digits.length < 4) return num;
  return `•••• •••• ${digits.slice(-3)}`;
}

/** Simple non-crypto id for mock records. */
export function uid(prefix = "id"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Clamp a number between min and max. */
export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
