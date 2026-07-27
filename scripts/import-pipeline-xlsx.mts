/**
 * Import the team's real workbook (Pipeline_2026.xlsx) into the database.
 *
 *   npx tsx --conditions=react-server scripts/import-pipeline-xlsx.mts --dry-run
 *   npx tsx --conditions=react-server scripts/import-pipeline-xlsx.mts
 *   … --file ~/Downloads/Pipeline_2026.xlsx --owner Richard --verbose
 *
 * WHY --conditions=react-server: the write path pulls src/lib/db/pg.ts, which
 * starts with `import "server-only"`. That package's package.json exports map
 * throws outside the react-server condition, exactly as scripts/crawl.mts is
 * invoked in package.json ("crawl": "tsx --conditions=react-server …").
 * The db module is imported DYNAMICALLY below, so a pure --dry-run also works
 * under a plain `npx tsx` with no flag at all.
 *
 * SAFETY: --dry-run is FORCED when DATABASE_URL is unset, so this can never
 * accidentally write to whatever database happens to be configured elsewhere.
 *
 * IDEMPOTENT: every pipeline row is keyed on (source_id, external_id) — the
 * unique constraint declared in deploy/db/schema.sql — and every forecast row on
 * the partial unique index forecast_url_key (detail_url). A second run reports
 * "unchanged" and writes nothing, because the row's content_hash is compared
 * first.
 *
 * ZERO NEW DEPENDENCIES. This repo has no `xlsx` package and package.json is not
 * this script's to edit, so the .xlsx (a ZIP of XML) is read directly with
 * node:zlib. The reader below was diffed cell-for-cell against SheetJS 0.18.5
 * over all 74x17 Pipeline cells and all 7x7 Forecast cells — see docs/
 * PIPELINE-2026.md § Verifying the reader.
 *
 * PREREQUISITES, in this order:
 *   1. deploy/db/migrations/001-pipeline-2026.sql  (the 11-stage vocabulary and
 *      the 18 sheet columns; without it every insert fails the CHECK)
 *   2. deploy/db/seed-sources.sql                  (the 'manual' source row)
 */
import { readFileSync, existsSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
// The ONE department matcher. Pure (no "server-only"), so it imports cleanly
// here, in the crawl pipeline and in scripts/test-departments.mts alike.
import {
  DEPARTMENTS as PRIORITY_DEPARTMENTS,
  matchDepartment,
  departmentForOpportunity,
} from "../src/lib/departments.ts";
// The ONE targeting engine, for the same reason — see § 7a. Both modules are
// pure (their only imports are `import type`, which the transpiler erases), so
// a --dry-run still runs under a plain `npx tsx` with no db reachable.
import { scoreOpportunity, type EngineResult } from "../src/lib/targeting/engine.ts";
import { DEFAULT_TARGETING_PROFILE } from "../src/lib/targeting/defaults.ts";
import type { TargetingProfile } from "../src/lib/types.ts";

// ═══════════════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════════════

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  if (i !== -1) return argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "true";
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
};
const has = (name: string) => flag(name) !== undefined;

if (has("--help")) {
  console.log(`
import-pipeline-xlsx — load Pipeline_2026.xlsx into opportunities + forecast_opportunities

  --file <path>     workbook to read      (default ~/Downloads/Pipeline_2026.xlsx)
  --owner <name>    users.name to assign  (default "Richard")
  --source <slug>   sources.slug to hang the rows off (default "manual")
  --dry-run         parse, report, write NOTHING. Forced when DATABASE_URL is unset.
  --verbose         print one line per row instead of only the exceptions
  --help
`);
  process.exit(0);
}

const FILE = resolve(
  (flag("--file") ?? `${homedir()}/Downloads/Pipeline_2026.xlsx`).replace(/^~(?=\/|$)/, homedir()),
);
const OWNER_NAME = flag("--owner") ?? "Richard";
const SOURCE_SLUG = flag("--source") ?? "manual";
const VERBOSE = has("--verbose");
const HAS_DB = !!process.env.DATABASE_URL;
const DRY_RUN = has("--dry-run") || !HAS_DB;

// ═══════════════════════════════════════════════════════════════════════════
// The reader and row mapper live in src/lib/import/pipeline-workbook.ts so that
// this CLI and the in-app upload (/api/import/pipeline) map a workbook the SAME
// way. They used to live here, which is how the importer ended up with its own
// department table that classified rows differently from the real matcher.
// ═══════════════════════════════════════════════════════════════════════════
import {
  mapWorkbook,
  type MappedOpp,
  type MappedForecast,
  type Issue,
} from "../src/lib/import/pipeline-workbook.ts";
import { applyMappedWorkbook, ImportError, scoreRow } from "../src/lib/import/apply.ts";

// ═══════════════════════════════════════════════════════════════════════════
// 7a. Targeting engine
//
// A hand-typed row is a REAL opportunity that simply was not crawled. Before
// this it arrived with pursuit_score / pursuit_bucket / urgency all null, and a
// null bucket is not a neutral value anywhere in this app — it is a value that
// fails every bucket filter there is, starting with the Opportunities page's
// default "Pursue + Capture review" view. The operator imported 71 rows, opened
// the page and was shown 0. So the importer scores its rows through the SAME
// pure engine the crawler runs (src/lib/crawl/pipeline.ts) against the SAME
// stored profile, and they become ordinary rows: sortable by score, visible to
// the urgency lens, and re-scorable by /api/targeting/rescore.
//
// (The bucket alone does not make them visible — measured over this workbook the
// engine tops out at 48 against a captureReview threshold of 60, so they all
// bucket IGNORE/MANUAL_REVIEW. That half is fixed in src/lib/db/opportunities.ts,
// which exempts hand-entered rows from the triage gates. This half is about not
// leaving them half-populated and second-class in every other view.)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The live profile in write mode; the seed profile in --dry-run, so a dry run
 * still reports a realistic bucket split without a database. The dynamic import
 * matches ../src/lib/db/pg below: profile.ts reaches Postgres through
 * `import "server-only"`, which must not be pulled in on the dry-run path.
 */
async function loadProfile(): Promise<TargetingProfile> {
  if (DRY_RUN) return DEFAULT_TARGETING_PROFILE;
  const { getTargetingProfile } = await import("../src/lib/targeting/profile");
  return getTargetingProfile();
}

/** Same shape the crawler feeds the engine, from the sheet's columns. */

/** The crawler's one-line summary of why a row scored what it scored. */
function engineSummary(e: EngineResult): string {
  if (e.excludedReason) return `Excluded: ${e.excludedReason}`;
  return (
    e.breakdown.filter((b) => b.points > 0).slice(0, 4).map((b) => `${b.criterion} +${b.points}`).join(" · ") ||
    "No targeting criteria matched"
  );
}

/**
 * Engine-owned columns, written on INSERT and refreshed whenever the SHEET
 * CONTENT changes (the crawler does exactly this on capture and on AMENDED).
 *
 * DELIBERATELY NOT HERE, though the engine also emits them:
 *   set_asides, contract_vehicle — the sheet has its own "Set Aside" and
 *   "Vehicle" columns and the human who typed them is authoritative. They are
 *   already in COLS below; adding the engine's guesses would overwrite typing.
 *   relevance_score / _reason / _method are insert-only for the same kind of
 *   reason: after insert they belong to the AI analyst, whose verdict must not be
 *   flattened back to a keyword score by a re-import.
 *
 * score_breakdown is the ONE jsonb column this importer writes, so it — and only
 * it — must be JSON.stringify'd. Everything else here is scalar; set_asides /
 * naics_codes stay text[] and stay bound raw.
 */
const ENGINE_COLS = [
  "pursuit_score", "pursuit_bucket", "urgency",
  "solicitation_type", "agency_priority", "excluded_reason", "score_breakdown",
] as const;
const engineValues = (e: EngineResult): unknown[] => [
  e.pursuitScore, e.bucket, e.urgency,
  e.solicitationType, e.agencyPriority, e.excludedReason, JSON.stringify(e.breakdown),
];

// ═══════════════════════════════════════════════════════════════════════════
// 7. Main
// ═══════════════════════════════════════════════════════════════════════════

const fmt = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));

async function main() {
  console.log("─".repeat(78));
  console.log("Pipeline_2026 importer");
  console.log("─".repeat(78));
  if (!existsSync(FILE)) {
    console.error(`\n✗ workbook not found: ${FILE}\n  pass --file <path>\n`);
    process.exit(1);
  }
  console.log(`  workbook : ${FILE}`);
  console.log(`  mode     : ${DRY_RUN ? "DRY RUN — nothing will be written" : "WRITE"}` +
    (!HAS_DB ? "  (DATABASE_URL is unset, so dry-run is forced)" : ""));
  console.log(`  source   : sources.slug = "${SOURCE_SLUG}"`);
  console.log(`  owner    : users.name ~ "${OWNER_NAME}"`);

  const wb = mapWorkbook(readFileSync(FILE), FILE);
  if (wb.error) { console.error(`\n✗ ${wb.error}\n`); process.exit(1); }
  console.log(`  sheets   : ${wb.sheetNames.map((n) => `"${n}"`).join(", ")}` +
    (wb.date1904 ? "   [1904 date system]" : ""));

  const p = wb.pipeline!;
  console.log(`\n[${p.sheet}] header on sheet row ${p.headerRow}, ${p.matched}/${p.total} columns matched` +
    (p.missing.length ? `\n  ! unmatched: ${p.missing.join(", ")}` : ""));
  if (wb.forecast) {
    console.log(`\n[${wb.forecast.sheet}] header on sheet row ${wb.forecast.headerRow}, ` +
      `${wb.forecast.matched}/${wb.forecast.total} columns matched`);
  } else {
    console.log("\n[forecast] no recognised forecast sheet — skipped");
  }

  const opps = wb.opps, forecasts = wb.forecasts, issues = wb.issues;
  const pipeRowsRead = wb.rowsRead, pipeBlank = wb.blankRows, fcstRowsRead = wb.forecastRowsRead;

  // ── score (§ 7a) ──────────────────────────────────────────────────────────
  // Keyed by external_id, which mapPipelineRow() has already made unique. NOT
  // folded into MappedOpp: content_hash is computed over that object, and the
  // engine's output moves on its own (urgency counts down day by day), so
  // hashing it would make every re-run report 71 "updated" rows and destroy the
  // idempotency the whole importer is built on.
  const profile = await loadProfile();
  const scores = new Map<string, EngineResult>();
  for (const o of opps) scores.set(o.external_id, scoreRow(o, profile));

  // ── what we are about to do ───────────────────────────────────────────────
  if (VERBOSE) {
    console.log(`\n${"row".padStart(4)}  ${"external_id".padEnd(30)} ${"stage".padEnd(10)} ${"dept".padEnd(6)} ${"st".padEnd(3)} ${"bucket".padEnd(14)} due`);
    for (const o of opps) {
      const e = scores.get(o.external_id);
      console.log(`${String(o.sheetRow).padStart(4)}  ${o.external_id.padEnd(30).slice(0, 30)} ${o.pipeline_stage.padEnd(10)} ` +
        `${fmt(o.department).padEnd(6)} ${fmt(o.state).padEnd(3)} ${`${fmt(e?.bucket)}/${e?.pursuitScore ?? "—"}`.padEnd(14)} ` +
        `${o.due_date ? o.due_date.slice(0, 16).replace("T", " ") : fmt(null)}`);
    }
    for (const f of forecasts) {
      console.log(`${String(f.sheetRow).padStart(4)}  [forecast] ${f.department}/${f.sub_agency} — ${f.title}`);
    }
  }

  // ── write ─────────────────────────────────────────────────────────────────
  let applied;
  try {
    applied = await applyMappedWorkbook({
      opps, forecasts, scores, issues,
      sourceSlug: SOURCE_SLUG, ownerName: OWNER_NAME, commit: !DRY_RUN,
    });
  } catch (e) {
    if (e instanceof ImportError) { console.error(`\n✗ ${e.message}\n`); process.exit(1); }
    throw e;
  }
  const { counts, failures, ownerId } = applied;

  // ── report ────────────────────────────────────────────────────────────────
  const skips = issues.filter((i) => i.level === "SKIP");
  const warns = issues.filter((i) => i.level === "WARN");

  console.log(`\n${"═".repeat(78)}\nSUMMARY\n${"═".repeat(78)}`);
  console.log(`  Pipeline sheet   rows read ${pipeRowsRead}` +
    (pipeBlank ? ` (+${pipeBlank} blank row${pipeBlank === 1 ? "" : "s"} ignored)` : "") +
    `, mapped ${opps.length}, skipped ${pipeRowsRead - opps.length}`);
  console.log(`  Forecast sheet   rows read ${fcstRowsRead}, mapped ${forecasts.length}, skipped ${fcstRowsRead - forecasts.length}`);
  if (DRY_RUN) {
    if (applied.classified) {
      // A database was reachable, so this is what WOULD change — not just how
      // many rows the sheet holds. Saying "would write 71" when 71 are already
      // present and identical is the kind of false report that gets believed.
      console.log(`\n  DRY RUN — would ADD ${counts.inserted}, UPDATE ${counts.updated}, ` +
        `leave ${counts.unchanged} unchanged` +
        `  ·  forecast: add ${counts.fInserted}, update ${counts.fUpdated}, ` +
        `leave ${counts.fUnchanged} unchanged. Nothing was written.`);
    } else {
      console.log(`\n  DRY RUN — mapped ${opps.length} opportunit${opps.length === 1 ? "y" : "ies"} ` +
        `and ${forecasts.length} forecast row${forecasts.length === 1 ? "" : "s"}. No database was ` +
        `reachable, so how many are NEW versus already present is unknown. Nothing was written.`);
    }
  } else {
    console.log(`\n  opportunities            inserted ${counts.inserted}, updated ${counts.updated}, unchanged ${counts.unchanged}`);
    console.log(`  forecast_opportunities   inserted ${counts.fInserted}, updated ${counts.fUpdated}, unchanged ${counts.fUnchanged}`);
    if (failures.length) console.log(`  FAILED WRITES            ${failures.length}`);
  }

  const byDept = new Map<string, number>();
  for (const o of opps) byDept.set(o.department ?? "(none)", (byDept.get(o.department ?? "(none)") ?? 0) + 1);
  const byStage = new Map<string, number>();
  for (const o of opps) byStage.set(o.pipeline_stage, (byStage.get(o.pipeline_stage) ?? 0) + 1);
  const byBucket = new Map<string, number>();
  for (const o of opps) {
    const b = scores.get(o.external_id)?.bucket ?? "(unscored)";
    byBucket.set(b, (byBucket.get(b) ?? 0) + 1);
  }
  console.log(`\n  stages      ${[...byStage].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  console.log(`  departments ${[...byDept].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  // These buckets are the engine's opinion, NOT a visibility gate: hand-entered
  // rows are exempt from the Opportunities page's triage filters either way (see
  // § 7a and src/lib/db/opportunities.ts).
  console.log(`  buckets     ${[...byBucket].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join("  ")}` +
    `${DRY_RUN ? "   [scored against the SEED profile — no db]" : ""}`);
  const states = [...new Set(opps.map((o) => o.state).filter(Boolean))];
  console.log(`  states      ${states.length ? states.join(", ") : "(none derived)"}`);

  if (skips.length) {
    console.log(`\n${"─".repeat(78)}\nSKIPPED — ${skips.length} row${skips.length === 1 ? "" : "s"} NOT imported\n${"─".repeat(78)}`);
    for (const s of skips) console.log(`  sheet row ${String(s.row).padStart(3)}  [${s.field}]  ${s.detail}`);
  } else {
    console.log(`\n  SKIPPED: none — every non-blank row mapped to a row in the database.`);
  }

  if (warns.length) {
    console.log(`\n${"─".repeat(78)}\nPARTIALLY MAPPED — ${warns.length} field-level issue${warns.length === 1 ? "" : "s"} across ${new Set(warns.map((w) => w.row)).size} rows\n` +
      `(every one of these rows IS imported; this is what could not be mapped confidently)\n${"─".repeat(78)}`);
    for (const w of warns) console.log(`  sheet row ${String(w.row).padStart(3)}  [${w.field}]  ${w.detail}`);
  }

  console.log("");
  if (failures.length) process.exit(1);
}

// Only run when executed as a script, so the reader above can be imported by a
// test harness without kicking off an import.
if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  main().catch((e) => { console.error("\n✗", e?.stack ?? e); process.exit(1); });
}
