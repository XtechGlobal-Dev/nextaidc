// Reasoning models (GPT-5, o-series) reject `max_tokens`/custom `temperature` and need `max_completion_tokens`
// with headroom (reasoning tokens count against it, or the answer starves to ""); classic models reject the reverse.

/** Reasoning models need max_completion_tokens + no custom temperature.
 *  `gpt-5-chat*` is the NON-reasoning ChatGPT variant, so it's excluded. */
export function isReasoningModel(model: string): boolean {
  const m = (model || "").toLowerCase().trim();
  if (m.startsWith("gpt-5-chat")) return false;
  return m.startsWith("gpt-5") || /^o\d/.test(m);
}

/** Reasoning tokens are spent inside max_completion_tokens; give the visible
 *  answer this much breathing room on top of the requested output size. */
const REASONING_TOKEN_HEADROOM = 3000;

export interface ChatBodyOpts {
  model: string;
  messages: unknown[];
  /** Intended size of the visible answer (maps to max_tokens / grows the
   *  reasoning cap). */
  maxTokens: number;
  /** Only applied to classic models; reasoning models ignore it (default 1). */
  temperature?: number;
  /** Force a strict JSON object response (supported by both families). */
  jsonObject?: boolean;
  /** Reasoning depth for reasoning models. Cheap/fast tasks → "minimal". */
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
}

/** Build the JSON body for POST /v1/chat/completions, adapted to the model. */
export function buildChatBody(opts: ChatBodyOpts): Record<string, unknown> {
  const body: Record<string, unknown> = { model: opts.model, messages: opts.messages };
  if (isReasoningModel(opts.model)) {
    body.max_completion_tokens = opts.maxTokens + REASONING_TOKEN_HEADROOM;
    body.reasoning_effort = opts.reasoningEffort ?? "low";
    // temperature intentionally omitted — only the default is accepted.
  } else {
    body.max_tokens = opts.maxTokens;
    if (typeof opts.temperature === "number") body.temperature = opts.temperature;
  }
  if (opts.jsonObject) body.response_format = { type: "json_object" };
  return body;
}

/** Billable units (thousands of tokens) for traceFetch's `unitsFromResponse`. Reasoning tokens are in
 *  `total_tokens` and OpenAI bills for them, so they count here too. */
export function openAiTokenUnits(body: unknown): number {
  const total = (body as { usage?: { total_tokens?: number } })?.usage?.total_tokens;
  return typeof total === "number" && total > 0 ? total / 1000 : 0;
}
