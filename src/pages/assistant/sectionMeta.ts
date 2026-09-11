import { Bell, BookOpen, ScrollText, Sliders, User, type LucideIcon } from "lucide-react";
import type { AgentSectionKey } from "@/types";

export interface SectionMeta {
  key: AgentSectionKey;
  index: number;
  label: string;
  blurb: string;
  /** CSS var for the accent color. */
  colorVar: string;
  icon: LucideIcon;
}

export const SECTIONS: SectionMeta[] = [
  { key: "identity", index: 1, label: "Identity", blurb: "Who your assistant is", colorVar: "--color-step-1", icon: User },
  { key: "knowledge", index: 2, label: "Knowledge & Services", blurb: "What it knows & offers", colorVar: "--color-step-2", icon: BookOpen },
  { key: "rules", index: 3, label: "Rules", blurb: "How it behaves", colorVar: "--color-step-3", icon: ScrollText },
  { key: "advanced", index: 4, label: "Advanced", blurb: "Master prompt & tuning", colorVar: "--color-step-5", icon: Sliders },
  { key: "automations", index: 5, label: "Notifications", blurb: "Post-call summary channels", colorVar: "--color-step-4", icon: Bell },
];

export function sectionByKey(key: AgentSectionKey): SectionMeta {
  return SECTIONS.find((s) => s.key === key)!;
}
