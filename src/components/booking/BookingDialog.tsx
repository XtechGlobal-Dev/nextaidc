import { useState } from "react";
import { CalendarDays, Loader2, CheckCircle2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiError } from "@/lib/api";
import { toast } from "sonner";

export function BookingDialog({
  open,
  onOpenChange,
  topic,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  topic: string;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", phone: "", date: "", time: "", message: "" });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  function reset() {
    setForm({ name: "", email: "", phone: "", date: "", time: "", message: "" });
    setDone(false);
    setBusy(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.email.trim()) {
      toast.error("Please enter your name and email");
      return;
    }
    setBusy(true);
    const preferredAt = [form.date, form.time].filter(Boolean).join(" ");
    try {
      await api.bookings.create({
        topic,
        name: form.name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        preferredAt,
        message: form.message.trim(),
      });
      setDone(true);
      toast.success("Booking requested 🎉", { description: "We'll confirm by email shortly." });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not submit booking");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-md">
        {done ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <CheckCircle2 className="size-12 text-success" />
            <DialogTitle>You're booked!</DialogTitle>
            <DialogDescription>
              Thanks {form.name.split(" ")[0] || "there"} — we've received your {topic.toLowerCase()} request and
              will confirm by email{form.date ? ` for ${form.date}${form.time ? ` at ${form.time}` : ""}` : ""}.
            </DialogDescription>
            <Button className="mt-2" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CalendarDays className="size-5 text-primary" /> {topic}
              </DialogTitle>
              <DialogDescription>Pick a time that suits you — we'll confirm by email.</DialogDescription>
            </DialogHeader>
            <form onSubmit={submit} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="bk-name">Full name</Label>
                <Input id="bk-name" value={form.name} onChange={set("name")} required />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="bk-email">Email</Label>
                  <Input id="bk-email" type="email" value={form.email} onChange={set("email")} required />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="bk-phone">Phone</Label>
                  <Input id="bk-phone" value={form.phone} onChange={set("phone")} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="bk-date">Preferred date</Label>
                  <Input id="bk-date" type="date" value={form.date} onChange={set("date")} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="bk-time">Preferred time</Label>
                  <Input id="bk-time" type="time" value={form.time} onChange={set("time")} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bk-msg">Anything we should know? (optional)</Label>
                <Textarea id="bk-msg" rows={2} value={form.message} onChange={set("message")} />
              </div>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy && <Loader2 className="size-4 animate-spin" />}
                Request booking
              </Button>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
