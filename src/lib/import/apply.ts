/**
 * Writing a mapped Pipeline_2026 workbook into the database.
 *
 * Split out of scripts/import-pipeline-xlsx.mts so the CLI and the in-app upload
 * (/api/import/pipeline) INSERT the same way, for the same reason the mapper is
 * shared: two write paths drift, and the one that drifts is always the one that
 * is not being watched.
 *
 * Idempotent by (source_id, external_id) + content_hash: re-importing the same
 * workbook reports every row "unchanged" and writes nothing. That is what makes
 * it safe to upload a corrected spreadsheet over the top of an earlier one.
 */
import type { MappedOpp, MappedForecast, Issue } from "./pipeline-workbook";
import { scoreOpportunity, type EngineResult } from "@/lib/targeting/engine";
import type { TargetingProfile } from "@/lib/types";

/** A condition the operator can fix — surfaced as a message, never a stack trace. */
export class ImportError extends Error {}

export interface ApplyOptions {
  opps: MappedOpp[];
  forecasts: MappedForecast[];
  scores: Map<string, EngineResult>;
  issues: Issue[];
  sourceSlug: string;
  ownerName: string;
  /** false = report what would happen and write nothing. */
  commit: boolean;
}

export interface ApplyResult {
  counts: { inserted: number; updated: number; unchanged: number;
            fInserted: number; fUpdated: number; fUnchanged: number };
  failures: { row: number; error: string }[];
  ownerId: string | null;
  committed: boolean;
  /** False when there was no database to compare against, so the counts are all
   *  zero and mean "not determined" rather than "nothing to do". */
  classified: boolean;
}

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


/**
 * Score one mapped row. Shared so the CLI preview, the upload preview and the
 * committed write all bucket a row the same way — a preview that scores
 * differently from the write is worse than no preview.
 */
export function scoreRow(o: MappedOpp, profile: TargetingProfile): EngineResult {
  return scoreOpportunity(
    {
      title: o.title,
      description: o.description,
      category: null, // the sheet has no category column
      agency: o.agency,
      naicsCode: o.naics_code,
      dueDate: o.due_date,
      estimatedValue: o.estimated_value,
      // The 'manual' source is seeded with state = null, so the row's OWN state
      // (derived from the POC block) is the only jurisdiction signal there is.
      sourceState: o.state,
    },
    profile,
  );
}

export async function applyMappedWorkbook(
  { opps, forecasts, scores, issues, sourceSlug, ownerName, commit }: ApplyOptions,
): Promise<ApplyResult> {
  const counts = { inserted: 0, updated: 0, unchanged: 0, fInserted: 0, fUpdated: 0, fUnchanged: 0 };
  const failures: { row: number; error: string }[] = [];
  let ownerId: string | null = null;

  // Runs in BOTH modes. A dry run still resolves the source, the owner and
  // every existing row, because that is the only way to answer "what would this
  // change?" — the question the preview exists to answer. It was previously
  // wrapped in `if (commit)`, so a preview reported 0 added / 0 updated /
  // 0 unchanged for a workbook holding 71 rows, and the confirm button read
  // "Import 0 bids". Only the INSERT/UPDATE statements below are gated now.
  // ...but only when there IS a database. `npx tsx … --dry-run` with no
  // DATABASE_URL is a supported way to check a workbook offline, and it must not
  // try to open a connection. Callers get classified:false and should describe
  // the outcome in terms of rows mapped rather than rows added.
  if (!process.env.DATABASE_URL) {
    return { counts, failures, ownerId: null, committed: false, classified: false };
  }

  {
    const { sql } = await import("@/lib/db/pg");

    const src = await sql<{ id: string }>(`select id from public.sources where slug = $1`, [sourceSlug]);
    if (!src.length) {
      throw new ImportError(
        `No sources row with slug "${sourceSlug}". Seed it first: npm run seed ` +
        `(deploy/db/seed-sources.sql creates the 'manual' source that My Bids reads).`);
    }
    const sourceId = src[0].id;

    // Requirement 3, "in the pipeline the name should be Richard": there is no
    // owner column in the sheet — the app already has assigned_to → users(id).
    const owner = await sql<{ id: string; name: string }>(
      `select id, name from public.users where name ilike $1 order by (name = $2) desc limit 1`,
      [`${ownerName}%`, ownerName],
    );
    if (owner.length) { ownerId = owner[0].id; console.log(`\n  assigning every row to users."${owner[0].name}"`); }
    else console.log(`\n  ! no users row matching "${ownerName}" — assigned_to left null. Insert the user and re-run to fill it in.`);

    const COLS = [
      "source_id", "external_id", "title", "agency", "naics_code", "naics_codes", "description",
      "due_date", "q_and_a_deadline", "estimated_value", "detail_url", "set_asides",
      "contract_vehicle", "is_shared", "date_found", "department", "sub_agency", "state",
      "poc_raw", "poc_name", "poc_email", "poc_phone", "rfx_number_raw",
      "period_of_performance", "estimated_value_text", "q_and_a_deadline_text", "due_date_text",
      "capture_notes", "outcome", "lessons_learned", "pipeline_stage", "content_hash",
    ] as const;
    // Everything the SHEET owns is refreshed on re-import. Deliberately absent:
    //   status              — the crawler/app owns the solicitation lifecycle
    //   first_seen_at, created_at                        — history
    // The engine-owned columns are appended separately from ENGINE_COLS (§ 7a):
    // they are not sheet values, and score_breakdown is jsonb and needs
    // JSON.stringify, which nothing in COLS does. naics_codes and set_asides are
    // text[] and are bound as RAW JS arrays — stringifying them would raise
    // "malformed array literal".
    const UPDATABLE = COLS.filter((c) => c !== "source_id" && c !== "external_id");

    for (const o of opps) {
      try {
        const existing = await sql<{ id: string; content_hash: string; pipeline_stage: string }>(
          `select id, content_hash, pipeline_stage from public.opportunities where source_id = $1 and external_id = $2`,
          [sourceId, o.external_id],
        );
        const values: unknown[] = [
          sourceId, o.external_id, o.title, o.agency, o.naics_code, o.naics_codes, o.description,
          o.due_date, o.q_and_a_deadline, o.estimated_value, o.detail_url, o.set_asides,
          o.contract_vehicle, o.is_shared, o.date_found, o.department, o.sub_agency, o.state,
          o.poc_raw, o.poc_name, o.poc_email, o.poc_phone, o.rfx_number_raw,
          o.period_of_performance, o.estimated_value_text, o.q_and_a_deadline_text, o.due_date_text,
          o.capture_notes, o.outcome, o.lessons_learned, o.pipeline_stage, o.content_hash,
        ];

        // Always present: `scores` is keyed by the same external_id and filled
        // for every mapped row above.
        const engine = scores.get(o.external_id)!;

        if (!existing.length) {
          // relevance_* mirror the crawler's insert: the engine score doubles as
          // the first-pass relevance until (and unless) the AI analyst runs.
          const cols = [...COLS, "status", "assigned_to", ...ENGINE_COLS,
                        "relevance_score", "relevance_reason", "relevance_method"];
          const vals = [...values, o.status, ownerId, ...engineValues(engine),
                        Math.min(100, engine.pursuitScore), engineSummary(engine), "engine"];
          if (commit) {
            await sql(
              `insert into public.opportunities (${cols.join(", ")}) values (${vals.map((_, i) => `$${i + 1}`).join(", ")})`,
              vals,
            );
          }
          counts.inserted++;
        } else if (existing[0].content_hash === o.content_hash) {
          // Nothing in the sheet moved, so nothing is rewritten — including the
          // score. Re-scoring an unchanged row is /api/targeting/rescore's job.
          counts.unchanged++;
        } else {
          const setCols = [...UPDATABLE, ...ENGINE_COLS];
          const setVals = [...UPDATABLE.map((c) => values[COLS.indexOf(c)]), ...engineValues(engine)];
          if (commit) {
            await sql(
              `update public.opportunities set ${setCols.map((c, i) => `${c} = $${i + 1}`).join(", ")},
                      updated_at = now(), last_seen_at = now()
                 where id = $${setCols.length + 1}`,
              [...setVals, existing[0].id],
            );
          }
          if (commit && existing[0].pipeline_stage !== o.pipeline_stage) {
            await sql(
              `insert into public.opportunity_status_log (opportunity_id, field, old_value, new_value, changed_by, reason)
               values ($1, 'pipeline_stage', $2, $3, $4, 'Pipeline_2026.xlsx import')`,
              [existing[0].id, existing[0].pipeline_stage, o.pipeline_stage, ownerName],
            );
          }
          counts.updated++;
        }
      } catch (e: unknown) {
        failures.push({ row: o.sheetRow, error: (e as Error)?.message ?? String(e) });
        issues.push({ row: o.sheetRow, level: "SKIP", field: "database",
                      detail: (e as Error)?.message ?? String(e) });
      }
    }

    for (const f of forecasts) {
      try {
        const found = f.detail_url
          ? await sql<{ id: string }>(`select id from public.forecast_opportunities where detail_url = $1`, [f.detail_url])
          : await sql<{ id: string }>(
              `select id from public.forecast_opportunities where title = $1 and department is not distinct from $2`,
              [f.title, f.department],
            );
        const vals = [f.date_found, f.department, f.sub_agency, f.title, f.detail_url, f.estimated_solicitation_date, f.set_asides];
        if (!found.length) {
          if (commit) {
            await sql(
              `insert into public.forecast_opportunities
                 (date_found, department, sub_agency, title, detail_url, estimated_solicitation_date, set_asides, created_by)
               values ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [...vals, ownerId],
            );
          }
          counts.fInserted++;
        } else if (!commit) {
          const r = await sql<{ changed: boolean }>(
            `select true as changed from public.forecast_opportunities
              where id = $8
                and (date_found, department, sub_agency, title, detail_url, estimated_solicitation_date, set_asides)
                    is distinct from ($1,$2,$3,$4,$5,$6,$7)`,
            [...vals, found[0].id],
          );
          if (r.length) counts.fUpdated++; else counts.fUnchanged++;
        } else {
          const r = await sql<{ changed: boolean }>(
            `update public.forecast_opportunities
                set date_found = $1, department = $2, sub_agency = $3, title = $4,
                    detail_url = $5, estimated_solicitation_date = $6, set_asides = $7, updated_at = now()
              where id = $8
                and (date_found, department, sub_agency, title, detail_url, estimated_solicitation_date, set_asides)
                    is distinct from ($1,$2,$3,$4,$5,$6,$7)
              returning true as changed`,
            [...vals, found[0].id],
          );
          if (r.length) counts.fUpdated++; else counts.fUnchanged++;
        }
      } catch (e: unknown) {
        failures.push({ row: f.sheetRow, error: (e as Error)?.message ?? String(e) });
        issues.push({ row: f.sheetRow, level: "SKIP", field: "database",
                      detail: (e as Error)?.message ?? String(e) });
      }
    }
  }

  return { counts, failures, ownerId, committed: commit, classified: true };
}
