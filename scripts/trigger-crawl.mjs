#!/usr/bin/env node
/**
 * Trigger a crawl against the running app (dev or prod).
 *   npm run crawl            # all active sources
 *   npm run crawl nc         # just one source slug
 *   BASE_URL=https://… npm run crawl
 */
const base = process.env.BASE_URL || "http://localhost:3001";
const source = process.argv[2];

const res = await fetch(`${base}/api/crawl`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(source ? { source } : {}),
});
const data = await res.json();
if (!res.ok) {
  console.error("Crawl failed:", data.error || res.status);
  process.exit(1);
}
for (const s of data.summaries ?? []) {
  console.log(
    `${s.status === "failed" ? "✗" : "✓"} ${s.sourceName.padEnd(28)} ` +
      `found ${s.itemsFound}  new ${s.newCount}  changed ${s.changedCount}  closed ${s.closedCount}` +
      (s.error ? `  ERROR: ${s.error}` : ` (${s.methodUsed})`),
  );
}
if (data.deadlines) {
  console.log(`Deadline alerts: ${data.deadlines.deadlineAlerts}, Q&A alerts: ${data.deadlines.qaAlerts}`);
}
