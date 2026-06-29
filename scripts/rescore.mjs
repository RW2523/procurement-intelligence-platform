#!/usr/bin/env node
/**
 * Backfill the LLM bid/no-bid relevance check over stored opportunities.
 *   npm run rescore                 # only items not yet LLM-scored (loops to completion)
 *   ALL=1 npm run rescore           # re-score everything
 *   BASE_URL=https://… AUTH=admin:pw npm run rescore
 */
const base = process.env.BASE_URL || "http://localhost:3001";
const all = !!process.env.ALL;
const auth = process.env.AUTH; // "user:pass" for the Basic-Auth-gated cloud deploy

const headers = { "Content-Type": "application/json" };
if (auth) headers["Authorization"] = "Basic " + Buffer.from(auth).toString("base64");

let total = 0;
for (let i = 0; i < 100; i++) {
  const res = await fetch(`${base}/api/relevance/rescore`, {
    method: "POST",
    headers,
    body: JSON.stringify(all && i === 0 ? { all: true, limit: 50 } : { limit: 50 }),
  });
  if (!res.ok) {
    console.error("rescore failed:", res.status, await res.text().catch(() => ""));
    process.exit(1);
  }
  const d = await res.json();
  total += (d.scored ?? 0) + (d.fallback ?? 0);
  const tags = (d.sample ?? []).map((s) => `${s.rec}:${s.score} ${s.title}`).join(" | ");
  console.log(`batch ${i + 1}: scored ${d.scored} (fallback ${d.fallback}), remaining ${d.remaining}`);
  if (tags) console.log("   e.g. " + tags);
  if (d.done || (all && (d.scored ?? 0) + (d.fallback ?? 0) === 0)) break;
}
console.log(`\nDone. Processed ${total} opportunities.`);
