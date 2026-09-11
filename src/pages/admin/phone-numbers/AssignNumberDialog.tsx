import { useEffect, useMemo, useState } from "react";
import { Loader2, Search, Users } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataCard, DataCardHeader } from "@/components/ui/data-card";
import { cn } from "@/lib/utils";
import { api, ApiError } from "@/lib/api";
import type { AssignableAgent } from "./types";

const SYSTEM_POOL = "__system_pool__";

interface Props {
  open: boolean;
  numberId: string | null;
  number: string | null;
  onClose: () => void;
  onAssigned: () => void | Promise<void>;
}

export function AssignNumberDialog({ open, numberId, number, onClose, onAssigned }: Props) {
  const [agents, setAgents] = useState<AssignableAgent[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string>(SYSTEM_POOL);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setSelected(SYSTEM_POOL);
    setLoadingAgents(true);
    api.admin.phoneNumbers
      .agents()
      .then(setAgents)
      .catch((e) => toast.error(e instanceof ApiError ? e.message : "Couldn't load agents"))
      .finally(() => setLoadingAgents(false));
  }, [open]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter((a) => `${a.name} ${a.userEmail}`.toLowerCase().includes(q));
  }, [agents, search]);

  async function submit() {
    if (!numberId) return;
    setBusy(true);
    try {
      const target = selected === SYSTEM_POOL ? null : agents.find((a) => a.id === selected);
      await api.admin.phoneNumbers.reassign(numberId, target ? target.id : null, target?.brandId ?? null);
      toast.success(selected === SYSTEM_POOL ? "Moved to the system pool" : "Assigned to agent");
      await onAssigned();
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Assignment failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Assign Phone Number</DialogTitle>
          <DialogDescription>
            Assign <span className="font-medium text-foreground tabular-nums">{number}</span> to an
            agent, or move it to the system pool.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            placeholder="Search by agent or user email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* System pool option */}
        <button
          type="button"
          onClick={() => setSelected(SYSTEM_POOL)}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors",
            selected === SYSTEM_POOL ? "border-primary bg-primary-tint/60" : "border-border hover:bg-muted/50",
          )}
        >
          <Radio checked={selected === SYSTEM_POOL} />
          <Users className="size-4 text-muted-foreground" />
          <span className="font-medium">System Pool (Free Users)</span>
        </button>

        {/* Agent list — desktop table */}
        <div className="hidden max-h-72 overflow-y-auto rounded-lg border border-border md:block">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 font-medium">Agent</th>
                <th className="px-3 py-2 font-medium">User</th>
              </tr>
            </thead>
            <tbody>
              {loadingAgents ? (
                <tr>
                  <td colSpan={2} className="px-3 py-8 text-center text-muted-foreground">
                    <Loader2 className="mx-auto size-5 animate-spin" />
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={2} className="px-3 py-8 text-center text-muted-foreground">
                    {search ? `No agents match “${search}”.` : "No agents yet."}
                  </td>
                </tr>
              ) : (
                filtered.map((a) => (
                  <tr
                    key={a.id}
                    onClick={() => setSelected(a.id)}
                    className={cn(
                      "cursor-pointer border-b border-border/60 last:border-0 transition-colors",
                      selected === a.id ? "bg-primary-tint/50" : "hover:bg-muted/40",
                    )}
                  >
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <Radio checked={selected === a.id} />
                        <div className="min-w-0">
                          <p className="truncate font-medium">{a.name}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {a.provider}
                            {a.autoRoutes && " · auto-routes on assign"}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">{a.userEmail}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Agent list — mobile cards */}
        <div className="max-h-72 space-y-2 overflow-y-auto md:hidden">
          {loadingAgents ? (
            <div className="rounded-lg border border-border px-3 py-8 text-center text-muted-foreground">
              <Loader2 className="mx-auto size-5 animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-lg border border-border px-3 py-8 text-center text-muted-foreground">
              {search ? `No agents match “${search}”.` : "No agents yet."}
            </div>
          ) : (
            filtered.map((a) => (
              <DataCard
                key={a.id}
                onClick={() => setSelected(a.id)}
                className={cn("p-3", selected === a.id && "border-primary/40 bg-primary-tint-soft")}
              >
                <DataCardHeader
                  lead={<Radio checked={selected === a.id} />}
                  title={a.name}
                  subtitle={
                    <>
                      {a.provider}
                      {a.autoRoutes && " · auto-routes on assign"}
                      {" · "}
                      {a.userEmail}
                    </>
                  }
                />
              </DataCard>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />} Assign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Radio({ checked }: { checked: boolean }) {
  return (
    <span
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
        checked ? "border-primary" : "border-muted-foreground/40",
      )}
    >
      {checked && <span className="size-2 rounded-full bg-primary" />}
    </span>
  );
}
