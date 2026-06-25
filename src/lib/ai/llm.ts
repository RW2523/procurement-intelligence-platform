import { config } from "@/lib/config";

/**
 * Thin provider interface over OpenRouter (the blueprint's LLM gateway). The model
 * name is config-driven, so "upgrade the model" is a one-line change. When no API
 * key is configured it falls back to a deterministic mock so the whole app still
 * works end-to-end (drafts are clearly tagged with model_used = "mock-engine").
 */
export interface GenerateParams {
  system?: string;
  user: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Deterministic fallback used when no key is configured or the API errors. */
  mock?: () => string;
}

export interface GenerateResult {
  content: string;
  model: string;
  mocked: boolean;
}

export async function llmGenerate(p: GenerateParams): Promise<GenerateResult> {
  const model = p.model ?? config.llm.generationModel;
  const fallback = () => (p.mock ? p.mock() : "");

  if (!config.llm.live) {
    return { content: fallback(), model: "mock-engine", mocked: true };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.llm.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://ajace.com",
        "X-Title": "AJACE Procurement Intelligence",
      },
      body: JSON.stringify({
        model,
        temperature: p.temperature ?? 0.4,
        max_tokens: p.maxTokens ?? 2200,
        messages: [
          ...(p.system ? [{ role: "system", content: p.system }] : []),
          { role: "user", content: p.user },
        ],
      }),
    }).finally(() => clearTimeout(timeout));

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenRouter HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = json.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("OpenRouter returned empty content");
    return { content, model, mocked: false };
  } catch {
    // Never hard-fail generation; degrade to the deterministic draft.
    return { content: fallback(), model: `${model} (fallback→mock)`, mocked: true };
  }
}

/** Short helper for summaries / scoring tasks using the cheaper model. */
export async function llmSummarize(prompt: string, mock?: () => string): Promise<string> {
  const r = await llmGenerate({
    user: prompt,
    model: config.llm.summaryModel,
    temperature: 0.2,
    maxTokens: 600,
    mock,
  });
  return r.content;
}
