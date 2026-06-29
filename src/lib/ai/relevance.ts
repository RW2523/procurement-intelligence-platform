import type {
  NormalizedOpportunity,
  RelevanceSettings,
  CompanySettings,
  BidRecommendation,
} from "@/lib/types";
import { config } from "@/lib/config";
import { llmGenerate } from "./llm";

/**
 * Bid / no-bid relevance scoring (0–100). Cheap, deterministic, local — runs in the
 * crawl pipeline so every opportunity gets a first-pass score with zero tokens.
 * Keyword + NAICS overlap against the company's configured profile.
 */
export function scoreRelevance(
  o: Pick<NormalizedOpportunity, "title" | "description" | "category" | "agency" | "naicsCode">,
  rel: RelevanceSettings,
): { score: number; reason: string } {
  const text = `${o.title ?? ""} ${o.description ?? ""} ${o.category ?? ""} ${o.agency ?? ""}`.toLowerCase();
  const matched: string[] = [];
  for (const kw of rel.keywords) {
    if (kw && text.includes(kw.toLowerCase())) matched.push(kw);
  }

  let score = Math.min(100, matched.length * 22);
  let naicsHit = false;
  if (o.naicsCode && rel.naics.some((n) => o.naicsCode?.startsWith(n))) {
    naicsHit = true;
    score = Math.max(score, 85);
  }
  score = Math.max(score, matched.length ? 35 : 8);

  const parts: string[] = [];
  if (matched.length) parts.push(`Matched keywords: ${matched.slice(0, 6).join(", ")}`);
  if (naicsHit) parts.push(`NAICS ${o.naicsCode} in target set`);
  if (!parts.length) parts.push("No keyword or NAICS overlap with company profile");

  return { score, reason: parts.join(" · ") };
}

// ── LLM bid/no-bid check ─────────────────────────────────────────────────────

export interface LLMRelevanceInput {
  id: string;
  title: string;
  agency?: string | null;
  category?: string | null;
  description?: string | null;
  naicsCode?: string | null;
}

export interface LLMRelevanceVerdict {
  score: number; // 0–100 fit to the company
  recommendation: BidRecommendation; // BID | REVIEW | NO_BID
  reason: string;
}

/** Build the company-profile context the LLM judges every solicitation against. */
export function buildCompanyProfile(company: CompanySettings, rel: RelevanceSettings): string {
  const caps = company.capabilities?.length ? company.capabilities.join(", ") : "";
  return [
    `Company: ${company.name}`,
    company.industry ? `Industry: ${company.industry}` : "",
    company.about ? `About: ${company.about}` : "",
    caps ? `Capabilities: ${caps}` : "",
    rel.keywords?.length ? `Target keywords: ${rel.keywords.join(", ")}` : "",
    rel.naics?.length ? `Target NAICS: ${rel.naics.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const SYSTEM_PROMPT =
  "You are a procurement bid/no-bid analyst. Given a company profile and a batch of " +
  "government solicitations, decide — for EACH — whether the company could realistically bid. " +
  "Judge ONLY against the profile. Be strict: solicitations for construction, road/paving, " +
  "buildings, food/catering, medical or transportation services, janitorial, landscaping, " +
  "furniture, vehicles, or other non-technology work are NO_BID — UNLESS they have a substantial " +
  "software, IT, data, AI, networking, or cybersecurity component. Reward true IT/software/AI/cyber/" +
  "cloud/data fit. Output strict JSON only.";

function buildBatchPrompt(profile: string, batch: LLMRelevanceInput[]): string {
  const list = batch.map((it, i) => ({
    i,
    title: it.title?.slice(0, 220) ?? "",
    agency: it.agency?.slice(0, 80) ?? "",
    category: it.category?.slice(0, 80) ?? "",
    naics: it.naicsCode ?? "",
    desc: (it.description ?? "").replace(/\s+/g, " ").slice(0, 320),
  }));
  return (
    `COMPANY PROFILE\n${profile}\n\n` +
    `SOLICITATIONS (JSON)\n${JSON.stringify(list)}\n\n` +
    `For each item return one object. Respond with ONLY a JSON array, no prose, no code fences:\n` +
    `[{"i":<index>,"score":<0-100 fit to THIS company>,"rec":"BID|REVIEW|NO_BID","reason":"<= 16 words why"}]\n` +
    `score: 100 = perfect IT/software/AI/cyber fit, 0 = entirely unrelated. ` +
    `rec: BID = clearly in our wheelhouse & worth pursuing; REVIEW = partial/uncertain tech component; ` +
    `NO_BID = unrelated to our IT capabilities.`
  );
}

function parseVerdicts(content: string, batch: LLMRelevanceInput[]): Map<string, LLMRelevanceVerdict> {
  const out = new Map<string, LLMRelevanceVerdict>();
  const start = content.indexOf("[");
  const end = content.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return out;
  let arr: unknown;
  try {
    arr = JSON.parse(content.slice(start, end + 1));
  } catch {
    return out;
  }
  if (!Array.isArray(arr)) return out;
  for (const row of arr as Record<string, unknown>[]) {
    const idx = Number(row.i);
    const item = batch[idx];
    if (!item) continue;
    let score = Number(row.score);
    if (!Number.isFinite(score)) score = 0;
    score = Math.max(0, Math.min(100, Math.round(score)));
    const recRaw = String(row.rec ?? "").toUpperCase();
    const rec: BidRecommendation =
      recRaw === "BID" ? "BID" : recRaw === "NO_BID" || recRaw === "NOBID" ? "NO_BID" : "REVIEW";
    out.set(item.id, {
      score,
      recommendation: rec,
      reason: String(row.reason ?? "").slice(0, 240) || "LLM relevance assessment",
    });
  }
  return out;
}

/** Run N async tasks with a bounded concurrency pool. */
async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * LLM bid/no-bid classification for a set of opportunities, batched and run with
 * bounded concurrency. Returns a map id → verdict. Items the model didn't return
 * (or all of them, if no API key) are simply absent — callers keep the keyword score.
 */
export async function classifyRelevanceLLM(
  items: LLMRelevanceInput[],
  profile: string,
  opts: { batchSize?: number; concurrency?: number } = {},
): Promise<Map<string, LLMRelevanceVerdict>> {
  const merged = new Map<string, LLMRelevanceVerdict>();
  if (!items.length || !config.llm.live) return merged;

  const batchSize = opts.batchSize ?? 10;
  const batches: LLMRelevanceInput[][] = [];
  for (let i = 0; i < items.length; i += batchSize) batches.push(items.slice(i, i + batchSize));

  const maps = await pool(batches, opts.concurrency ?? 4, async (batch) => {
    try {
      const r = await llmGenerate({
        system: SYSTEM_PROMPT,
        user: buildBatchPrompt(profile, batch),
        model: config.llm.summaryModel, // cheap model for scoring (blueprint §6)
        temperature: 0,
        maxTokens: 60 * batch.length + 80,
      });
      if (r.mocked) return new Map<string, LLMRelevanceVerdict>();
      return parseVerdicts(r.content, batch);
    } catch {
      return new Map<string, LLMRelevanceVerdict>();
    }
  });

  for (const m of maps) for (const [k, v] of m) merged.set(k, v);
  return merged;
}
