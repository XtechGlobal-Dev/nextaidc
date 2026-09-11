import type { LucideIcon } from "lucide-react";
import { Globe, Sparkles, PhoneCall, Rocket } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

const STEPS: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: Globe, title: "Enter your website URL", body: "We read your site to learn about your business, services, and contact details." },
  { icon: Sparkles, title: "Build your agent", body: "In minutes, your AI receptionist is trained on your business." },
  { icon: PhoneCall, title: "Test a live call", body: "Speak to your agent in the browser and see the transcript and summary." },
  { icon: Rocket, title: "Go live & forward calls", body: "Pick your AI number, start a free trial, and never miss a lead again." },
];

export function HowItWorksDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>How it works</DialogTitle>
          <DialogDescription>From website to live AI receptionist in four steps.</DialogDescription>
        </DialogHeader>
        <ol className="space-y-3">
          {STEPS.map(({ icon: Icon, title, body }, i) => (
            <li key={title} className="flex gap-3">
              <span className="relative flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-tint text-primary">
                <Icon className="size-4" />
                <span className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                  {i + 1}
                </span>
              </span>
              <div>
                <p className="text-sm font-semibold">{title}</p>
                <p className="text-sm text-muted-foreground">{body}</p>
              </div>
            </li>
          ))}
        </ol>
      </DialogContent>
    </Dialog>
  );
}
