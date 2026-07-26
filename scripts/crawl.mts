/**
 * Crawl chosen sources directly — no HTTP, no Next server, no auth gate.
 *
 *   npm run crawl -- tx ms              # just Texas and Mississippi
 *   npm run crawl -- tx ms --limit 25   # cap rows per source (fast smoke test)
 *   npm run crawl -- --all              # every active source
 *   npm run crawl                       # lists the slugs and exits
 *
 * Each source gets its own watchdog, so one unresponsive portal can never block
 * the rest of the run. Progress prints when a source STARTS, so a stuck source
 * is obvious immediately rather than looking like a silent hang.
 */
import { getActiveSources, getSourceBySlug } from "../src/lib/crawl/runner";
import { runCrawlForSource } from "../src/lib/crawl/pipeline";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : (argv[i + 1] ?? "true");
};
const limit = flag("--limit") ? Number(flag("--limit")) : undefined;
const timeoutMs = flag("--timeout") ? Number(flag("--timeout")) : 120_000;
const wantAll = argv.includes("--all");
const slugs = argv.filter((a) => !a.startsWith("--") && a !== String(limit) && a !== String(timeoutMs));

const active = await getActiveSources();
if (!wantAll && slugs.length === 0) {
  console.log("Pick sources to crawl. Available:\n");
  for (const s of active) console.log(`  ${s.slug.padEnd(5)} ${s.state ?? "--"}  ${s.name}`);
  console.log(`\n  npm run crawl -- tx ms --limit 25\n  npm run crawl -- --all`);
  process.exit(0);
}

let targets = active;
if (!wantAll) {
  targets = [];
  for (const slug of slugs) {
    const s = await getSourceBySlug(slug);
    if (!s) { console.error(`✗ no source with slug "${slug}" — run the seed first`); process.exit(1); }
    if (!s.is_active) console.warn(`  ! ${slug} is not active; crawling anyway`);
    targets.push(s);
  }
}

console.log(`crawling ${targets.length} source(s)${limit ? `, limit ${limit}/source` : ""}, watchdog ${timeoutMs}ms\n`);
let totalNew = 0, totalSeen = 0, failed = 0;

for (const source of targets) {
  process.stdout.write(`-> ${source.slug.padEnd(5)} ${source.name} ... `);
  const t0 = Date.now();
  try {
    // Promise.race gives a hard ceiling. The losing pipeline is not cancellable
    // mid-flight, so a timed-out source may still finish writing in the
    // background — that is safe (upserts are idempotent), just not waited on.
    const summary: any = await Promise.race([
      runCrawlForSource(source, { limit, trigger: "manual" }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("watchdog timeout")), timeoutMs)),
    ]);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    // CrawlSummary uses itemsFound/newCount — reading `found`/`created` made a
    // working crawl report 0 and hid a total insert failure.
    const found = summary?.itemsFound ?? 0;
    const created = summary?.newCount ?? 0;
    const errors = summary?.errorCount ?? 0;
    totalSeen += Number(found); totalNew += Number(created);
    console.log(`${summary?.status ?? "ok"} ${secs}s — ${found} found, ${created} new` +
      (errors ? `, ${errors} ERRORS` : "") +
      (summary?.warnings?.length ? `\n     ! ${summary.warnings.slice(0,3).join("\n     ! ")}` : ""));
  } catch (e: any) {
    failed++;
    console.log(`FAILED ${((Date.now() - t0) / 1000).toFixed(1)}s — ${e?.message || e}`);
  }
}

console.log(`\ndone: ${totalSeen} found, ${totalNew} new, ${failed} source(s) failed`);
process.exit(failed && !totalSeen ? 1 : 0);
