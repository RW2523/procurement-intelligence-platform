import type { NormalizedOpportunity, RelevanceSettings } from "@/lib/types";

/**
 * Bid / no-bid relevance scoring (0–100). Cheap, deterministic, local — runs in the
 * crawl pipeline so we never spend LLM tokens drafting road-paving RFPs for a
 * software firm. Keyword + NAICS overlap against the company's configured profile.
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
  // Floor: never 0 (keeps low-fit items visible but clearly deprioritized).
  score = Math.max(score, matched.length ? 35 : 8);

  const parts: string[] = [];
  if (matched.length) parts.push(`Matched keywords: ${matched.slice(0, 6).join(", ")}`);
  if (naicsHit) parts.push(`NAICS ${o.naicsCode} in target set`);
  if (!parts.length) parts.push("No keyword or NAICS overlap with company profile");

  return { score, reason: parts.join(" · ") };
}
