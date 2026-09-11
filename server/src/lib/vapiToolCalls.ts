/* Parsing for the tool-call batches Vapi POSTs to our dispatchers mid-call.
 * Shared by the booking dispatcher (routes/bookingAi.routes.ts) and the
 * caller-SMS dispatcher (routes/aiSms.routes.ts). Dependency-free. */

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ParsedToolCalls {
  calls: ToolCall[];
  /** The number the caller is dialling from, when Vapi sent it. */
  callerNumber: string;
  /** Vapi's call id — the natural idempotency/rate-limit key for one conversation. */
  callId: string;
}

/** Normalise the various shapes Vapi uses for a tool-call batch into a flat list. */
export function parseToolCalls(body: unknown): ParsedToolCalls {
  const msg = (body as { message?: Record<string, unknown> })?.message ?? {};
  const raw =
    (msg.toolCallList as unknown[]) ??
    (msg.toolCalls as unknown[]) ??
    (msg.toolWithToolCallList as unknown[]) ??
    [];
  const calls: ToolCall[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const it = item as Record<string, any>;
    const fn = it.function ?? it;
    const name = String(fn?.name ?? it?.name ?? "");
    if (!name) continue;
    let args: Record<string, unknown> = {};
    const rawArgs = fn?.arguments ?? it?.arguments ?? {};
    if (typeof rawArgs === "string") {
      try {
        args = JSON.parse(rawArgs);
      } catch {
        args = {};
      }
    } else if (rawArgs && typeof rawArgs === "object") {
      args = rawArgs as Record<string, unknown>;
    }
    calls.push({ id: String(it.id ?? it.toolCallId ?? ""), name, args });
  }
  const call = (msg.call ?? {}) as Record<string, any>;
  return {
    calls,
    callerNumber: String(call?.customer?.number ?? ""),
    callId: String(call?.id ?? ""),
  };
}

/** Read a string argument, trimmed. Tool args arrive from an LLM, so anything
 *  that isn't a string is treated as absent rather than coerced. */
export const toolArgString = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Read a boolean argument. Models sometimes emit the string "true"/"false"
 *  instead of a JSON boolean, so accept both. */
export function toolArgBoolean(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.trim().toLowerCase() === "true";
  return false;
}
