import { useState } from "react";
import { Plus, Trash2, Pencil, Check, X } from "lucide-react";
import { useAgentStore } from "@/stores/useAgentStore";
import { Input, Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SectionShell, FieldGroup } from "../SectionShell";
import { sectionByKey } from "../sectionMeta";
import { uid, cn } from "@/lib/utils";
import type { CaptureField, FaqItem } from "@/types";

export function KnowledgeSection() {
  const knowledge = useAgentStore((s) => s.config.knowledge);
  const update = useAgentStore((s) => s.updateSection);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");

  const setFields = (captureFields: CaptureField[]) =>
    update("knowledge", { captureFields });
  const faqs = knowledge.faqs ?? [];
  const setFaqs = (next: FaqItem[]) => update("knowledge", { faqs: next });

  const services = knowledge.services ?? [];
  const setServices = (next: string[]) => update("knowledge", { services: next });

  function addService() {
    setServices(["", ...services]);
  }
  function updateService(index: number, value: string) {
    setServices(services.map((s, i) => (i === index ? value : s)));
  }
  function removeService(index: number) {
    setServices(services.filter((_, i) => i !== index));
  }

  function addFaq() {
    setFaqs([{ id: uid("faq"), question: "", answer: "" }, ...faqs]);
  }
  function updateFaq(id: string, patch: Partial<FaqItem>) {
    setFaqs(faqs.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }
  function removeFaq(id: string) {
    setFaqs(faqs.filter((f) => f.id !== id));
  }

  function addField() {
    setFields([{ id: uid("cf"), label: "New field", enabled: true }, ...knowledge.captureFields]);
  }
  function toggleField(id: string, enabled: boolean) {
    setFields(knowledge.captureFields.map((f) => (f.id === id ? { ...f, enabled } : f)));
  }
  function removeField(id: string) {
    setFields(knowledge.captureFields.filter((f) => f.id !== id));
  }
  function commitEdit(id: string) {
    if (editLabel.trim()) {
      setFields(knowledge.captureFields.map((f) => (f.id === id ? { ...f, label: editLabel.trim() } : f)));
    }
    setEditingId(null);
  }

  return (
    <SectionShell meta={sectionByKey("knowledge")}>
      <FieldGroup
        title="Services"
        description="The services your business offers — pulled from your website or onboarding. Edit them so your assistant describes them accurately."
        action={
          <Button size="sm" variant="outline" onClick={addService}>
            <Plus className="size-4" /> Add Service
          </Button>
        }
      >
        {services.length === 0 && (
          <button
            onClick={addService}
            className="mb-1 w-full rounded-lg border border-dashed border-border bg-warm px-3 py-3 text-left text-xs text-muted-foreground hover:border-primary hover:text-primary"
          >
            No services yet — add what your business offers (e.g. <strong>concrete driveways</strong>,{" "}
            <strong>emergency plumbing</strong>) so your assistant knows what you do.
          </button>
        )}
        <div className="space-y-2">
          {services.map((s, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                placeholder="e.g. Concrete driveways"
                value={s}
                onChange={(e) => updateService(i, e.target.value)}
              />
              <button
                onClick={() => removeService(i)}
                className="shrink-0 text-muted-foreground hover:text-danger"
                aria-label="Remove service"
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
        </div>
      </FieldGroup>

      <FieldGroup
        title="Information to Capture"
        description="Details the assistant gathers naturally during the call."
        action={
          <Button size="sm" variant="outline" onClick={addField}>
            <Plus className="size-4" /> Add
          </Button>
        }
      >
        {knowledge.captureFields.length === 0 && (
          <button
            onClick={addField}
            className="mb-1 w-full rounded-lg border border-dashed border-border bg-warm px-3 py-3 text-left text-xs text-muted-foreground hover:border-primary hover:text-primary"
          >
            Nothing captured yet — add details like <strong>name</strong>, <strong>phone</strong>, or{" "}
            <strong>reason for calling</strong> that the assistant should collect.
          </button>
        )}
        <ul className="space-y-2">
          {knowledge.captureFields.map((f) => (
            <li
              key={f.id}
              className="flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2"
            >
              <Checkbox
                checked={f.enabled}
                onCheckedChange={(c) => toggleField(f.id, c === true)}
              />
              {editingId === f.id ? (
                <>
                  <Input
                    autoFocus
                    className="h-8 flex-1"
                    value={editLabel}
                    onChange={(e) => setEditLabel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit(f.id);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                  />
                  <button onClick={() => commitEdit(f.id)} className="text-success" aria-label="Save">
                    <Check className="size-4" />
                  </button>
                  <button onClick={() => setEditingId(null)} className="text-muted-foreground" aria-label="Cancel">
                    <X className="size-4" />
                  </button>
                </>
              ) : (
                <>
                  <span className={cn("flex-1 text-sm", !f.enabled && "text-muted-foreground line-through")}>
                    {f.label}
                  </span>
                  <button
                    onClick={() => {
                      setEditingId(f.id);
                      setEditLabel(f.label);
                    }}
                    className="text-muted-foreground hover:text-primary"
                    aria-label="Rename"
                  >
                    <Pencil className="size-4" />
                  </button>
                  <button
                    onClick={() => removeField(f.id)}
                    className="text-muted-foreground hover:text-danger"
                    aria-label="Remove"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      </FieldGroup>

      <FieldGroup
        title="FAQs"
        description="Question-and-answer pairs the assistant answers word-for-word — so it never guesses."
        action={
          <Button size="sm" variant="outline" onClick={addFaq}>
            <Plus className="size-4" /> Add FAQ
          </Button>
        }
      >
        {faqs.length === 0 && (
          <button
            onClick={addFaq}
            className="mb-1 w-full rounded-lg border border-dashed border-border bg-warm px-3 py-3 text-left text-xs text-muted-foreground hover:border-primary hover:text-primary"
          >
            No FAQs yet — add common questions like <strong>"Do you offer free quotes?"</strong> or{" "}
            <strong>"Where are you located?"</strong> with the exact answer the assistant should give.
          </button>
        )}
        <div className="space-y-3">
          {faqs.map((f) => (
            <div key={f.id} className="rounded-lg border border-border bg-background p-3">
              <div className="flex items-start gap-2">
                <Input
                  placeholder="Question — e.g. Do you offer free quotes?"
                  value={f.question}
                  onChange={(e) => updateFaq(f.id, { question: e.target.value })}
                />
                <button
                  onClick={() => removeFaq(f.id)}
                  className="mt-2 shrink-0 text-muted-foreground hover:text-danger"
                  aria-label="Remove FAQ"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
              <Textarea
                rows={2}
                className="mt-2"
                placeholder="Answer — exactly what the assistant should say"
                value={f.answer}
                onChange={(e) => updateFaq(f.id, { answer: e.target.value })}
              />
            </div>
          ))}
        </div>
      </FieldGroup>
    </SectionShell>
  );
}
