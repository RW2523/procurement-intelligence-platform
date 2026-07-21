/**
 * Run the full crawl pipeline directly (no HTTP, no Next.js server, no auth gate),
 * against whatever DB the env points at. Used for the initial bulk-seed crawl on a
 * fresh database, where a serverless function's timeout (Hobby: 60s) would be far
 * too short for 19 sources run sequentially.
 *
 * Each source gets its own hard watchdog timeout so one slow/unresponsive portal
 * can never block the rest of the run — it's logged as a timeout and the crawl
 * moves on. Progress prints as each source STARTS, not just when it finishes, so a
 * stuck source is visible immediately instead of a silent, unexplained pause.
 *
 *   tsx scripts/local-crawl.mts [limit] [perSourceTimeoutMs]
 */
import { getActiveSources } from "../src/lib/crawl/runner";
import { runCrawlForSource } from "../src/lib/crawl/pipeline";
import { scanDeadlines } from "../src/lib/notify/deadlines";

const limit = process.argv[2] ? Number(process.argv[2]) : undefined;
const perSourceTimeoutMs = process.argv[3] ? Number(process.argv[3]) : 120_000;

const started = new Date();
console.log(`crawl start ${started.toISOString()}${limit ? ` (limit=${limit}/source)` : ""} (watchdog=${perSourceTimeoutMs}ms/source)`);

const sources = await getActiveSources();
console.log(`${sources.length} active sources to crawl`);

const summaries: any[] = [];
for (const source of sources) {
  const t0 = Date.now();
  process.stdout.write(`-> starting ${source.name}...`);
  try {
    const summary = await Promise.race([
      runCrawlForSource(source, { trigger: "manual", limit }),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`watchdog timeout after ${perSourceTimeoutMs}ms`)), perSourceTimeoutMs)),
    ]);
    summaries.push(summary as any);
    const s = summary as any;
    const ok = s.status !== "failed";
    console.log(
      ` ${ok ? "OK" : "FAIL"}  found=${s.itemsFound ?? 0} new=${s.newCount ?? 0} changed=${s.changedCount ?? 0} closed=${s.closedCount ?? 0}` +
        (s.error ? `  ERROR: ${s.error}` : `  (${s.methodUsed ?? ""})`) +
        `  [${Date.now() - t0}ms]`,
    );
  } catch (e: any) {
    console.log(` TIMEOUT/ERROR after ${Date.now() - t0}ms: ${e.message}`);
    summaries.push({ sourceName: source.name, status: "failed", itemsFound: 0, newCount: 0, changedCount: 0, closedCount: 0, error: e.message });
  }
}

let totalFound = 0, totalNew = 0, totalChanged = 0, totalClosed = 0, failed = 0;
for (const s of summaries) {
  if (s.status === "failed") failed++;
  totalFound += s.itemsFound ?? 0;
  totalNew += s.newCount ?? 0;
  totalChanged += s.changedCount ?? 0;
  totalClosed += s.closedCount ?? 0;
}

const deadlines = await scanDeadlines();

console.log("");
console.log(`TOTALS: sources=${summaries.length} failed=${failed} found=${totalFound} new=${totalNew} changed=${totalChanged} closed=${totalClosed}`);
console.log(`Deadline alerts: ${deadlines.deadlineAlerts}, Q&A alerts: ${deadlines.qaAlerts}`);
console.log(`elapsed: ${Math.round((Date.now() - started.getTime()) / 1000)}s`);
