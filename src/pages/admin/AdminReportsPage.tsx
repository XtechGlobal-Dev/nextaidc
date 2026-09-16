import { useEffect, useState } from "react";
import { Eye, FileBarChart, Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, ApiError, type UserDigest } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { useAuthStore } from "@/stores/useAuthStore";
import { isSuperAdminRole } from "@/lib/roles";

export default function AdminReportsPage() {
  const [lastRun, setLastRun] = useState<string | null>(null);
  const canSendDigests = useAuthStore((s) => isSuperAdminRole(s.user?.role));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [userId, setUserId] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<UserDigest | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const { lastRunAt } = await api.admin.reportsLastRun();
        if (active) setLastRun(lastRunAt);
      } catch {
        /* non-critical */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  async function send() {
    setSending(true);
    try {
      const result = await api.admin.sendDigests();
      toast.success(`Digests sent: ${result.sent}, skipped: ${result.skipped}`);
      setConfirmOpen(false);
      const { lastRunAt } = await api.admin.reportsLastRun();
      setLastRun(lastRunAt);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to send digests");
    } finally {
      setSending(false);
    }
  }

  async function loadPreview() {
    if (!userId.trim()) {
      toast.error("Enter a user ID to preview");
      return;
    }
    setPreviewing(true);
    setPreview(null);
    try {
      const digest = await api.admin.previewDigest(userId.trim());
      setPreview(digest);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not build preview");
    } finally {
      setPreviewing(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle="Weekly digest emails summarizing each customer's call activity."
        actions={
          // Platform-wide broadcast to every brand's customers — super admin only, matching requireSuperAdmin on the route.
          canSendDigests ? (
            <Button onClick={() => setConfirmOpen(true)}>
              <Send className="size-4" /> Send digests now
            </Button>
          ) : null
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="p-6 lg:col-span-2">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <FileBarChart className="size-4 text-primary" /> Weekly digest
          </h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Each customer with an active profile receives an email summarizing the past 7 days: calls
            handled, leads captured, minutes used, and missed calls. Sending requires SMTP to be
            configured in Settings. The scheduler runs automatically when{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">ENABLE_DIGESTS=true</code> is set on
            the server; otherwise trigger it manually here.
          </p>
        </Card>

        <Card className="p-6">
          <p className="text-sm text-muted-foreground">Last run</p>
          <p className="mt-1 text-lg font-semibold">{lastRun ? formatDate(lastRun) : "Never"}</p>
        </Card>
      </div>

      <Card className="mt-4 p-6">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <Eye className="size-4 text-primary" /> Preview a digest
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Render the digest email for a single user by their ID.
        </p>
        <div className="mt-4 flex gap-2">
          <Input
            placeholder="User ID…"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            className="max-w-md"
          />
          <Button variant="outline" onClick={loadPreview} disabled={previewing}>
            {previewing ? <Loader2 className="size-4 animate-spin" /> : <Eye className="size-4" />}
            Preview
          </Button>
        </div>

        {preview && (
          <div className="mt-5">
            <p className="mb-2 text-sm font-medium">{preview.subject}</p>
            <div
              className="prose prose-sm max-w-none rounded-[var(--radius-card)] border border-border bg-background p-5 text-sm text-foreground/80"
              dangerouslySetInnerHTML={{ __html: preview.html }}
            />
          </div>
        )}
      </Card>

      <Dialog open={confirmOpen} onOpenChange={(o) => !sending && setConfirmOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send weekly digests?</DialogTitle>
            <DialogDescription>
              This builds and emails a digest to every customer with a profile. Make sure SMTP is
              configured first.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={sending}>
              Cancel
            </Button>
            <Button onClick={send} disabled={sending}>
              {sending && <Loader2 className="size-4 animate-spin" />}
              Send now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
