import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/guard";
import { mapWorkbook } from "@/lib/import/pipeline-workbook";
import { applyMappedWorkbook, ImportError, scoreRow } from "@/lib/import/apply";
import { getTargetingProfile } from "@/lib/targeting/profile";
import type { EngineResult } from "@/lib/targeting/engine";
import { mb } from "@/lib/documents/limits";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Upload a Pipeline workbook (.xlsx) and import it into My Bids.
 *
 * TWO CALLS, ALWAYS IN THIS ORDER:
 *   POST (no `commit`)      → parse, map, score, report. Writes NOTHING.
 *   POST with commit=true   → do it for real.
 *
 * The preview is not a courtesy. This workbook is the team's live pipeline, and
 * the mapper has to make judgement calls on cells a human typed in a hurry —
 * "1.96B BPA" as a value, two dates in one Due Date cell, an RFx # of "RFI??".
 * Every one of those decisions comes back in `issues` so the operator sees what
 * was inferred BEFORE any of it reaches the database.
 *
 * Re-uploading is safe: rows are keyed on (source_id, external_id) with a
 * content hash, so an unchanged row reports "unchanged" and is not rewritten.
 * Sending a corrected spreadsheet over the top of an earlier one is the intended
 * workflow, not an edge case.
 */

// A workbook is a spreadsheet, not a document library: this is far below the
// 25 MB attachment ceiling on purpose. The whole file is buffered in memory to
// be unzipped, on a 2 GB box that also runs payroll, so the ceiling here is
// about protecting that box rather than about what Excel can produce.
const MAX_WORKBOOK_BYTES = 8 * 1024 * 1024;

export async function POST(req: NextRequest) {
  // Importing rewrites the shared pipeline, so it is a writer-level action.
  // requireRole throws for anyone below, which the catch below turns into 403.
  let user;
  try {
    user = await requireRole("writer");
  } catch {
    return NextResponse.json(
      { error: "You need writer access to import a pipeline workbook." },
      { status: 403 },
    );
  }

  const len = req.headers.get("content-length");
  if (len && Number(len) > MAX_WORKBOOK_BYTES + 1024 * 1024) {
    return NextResponse.json(
      { error: `That file is ${mb(Number(len))}. The limit for a workbook is ${mb(MAX_WORKBOOK_BYTES)}.` },
      { status: 413 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Could not read the upload." }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file was attached." }, { status: 400 });
  }
  if (!/\.xlsx$/i.test(file.name)) {
    return NextResponse.json(
      {
        error: `"${file.name}" is not an .xlsx file. Save the workbook as Excel (.xlsx) — ` +
               `the older .xls format and .csv are not readable here.`,
      },
      { status: 415 },
    );
  }
  if (file.size > MAX_WORKBOOK_BYTES) {
    return NextResponse.json(
      { error: `"${file.name}" is ${mb(file.size)}. The limit for a workbook is ${mb(MAX_WORKBOOK_BYTES)}.` },
      { status: 413 },
    );
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "That file is empty." }, { status: 400 });
  }

  const commit = String(form.get("commit") ?? "") === "true";
  const buf = Buffer.from(await file.arrayBuffer());

  // Synchronous by design — see the concurrency note in pipeline-workbook.ts.
  const mapped = mapWorkbook(buf, file.name);
  if (mapped.error) {
    return NextResponse.json({ error: mapped.error }, { status: 422 });
  }
  if (!mapped.opps.length) {
    return NextResponse.json(
      {
        error:
          `No rows could be read from "${file.name}". The header row was found ` +
          `(${mapped.pipeline?.matched}/${mapped.pipeline?.total} columns matched) but every row below it was empty.`,
      },
      { status: 422 },
    );
  }

  // Score against the LIVE targeting profile, not the seed defaults, so the
  // buckets shown in the preview are the ones the board will actually use.
  const profile = await getTargetingProfile();
  const scores = new Map<string, EngineResult>();
  for (const o of mapped.opps) scores.set(o.external_id, scoreRow(o, profile));

  try {
    const applied = await applyMappedWorkbook({
      opps: mapped.opps,
      forecasts: mapped.forecasts,
      scores,
      issues: mapped.issues,
      sourceSlug: "manual",
      ownerName: "Richard",
      commit,
    });

    const stages: Record<string, number> = {};
    for (const o of mapped.opps) stages[o.pipeline_stage] = (stages[o.pipeline_stage] ?? 0) + 1;
    const departments: Record<string, number> = {};
    for (const o of mapped.opps) {
      const k = o.department ?? "(none)";
      departments[k] = (departments[k] ?? 0) + 1;
    }

    if (commit) {
      console.info(
        `[import] ${user.email} imported ${file.name}: ` +
        `${applied.counts.inserted} new, ${applied.counts.updated} updated, ` +
        `${applied.counts.unchanged} unchanged, ${applied.failures.length} failed`,
      );
    }

    return NextResponse.json({
      committed: commit,
      fileName: file.name,
      sheets: mapped.sheetNames,
      pipeline: mapped.pipeline,
      forecast: mapped.forecast,
      rowsRead: mapped.rowsRead,
      blankRows: mapped.blankRows,
      forecastRowsRead: mapped.forecastRowsRead,
      mapped: mapped.opps.length,
      counts: applied.counts,
      failures: applied.failures,
      ownerResolved: !!applied.ownerId,
      stages,
      departments,
      // The preview table: one entry per row, in sheet order.
      rows: mapped.opps.map((o) => ({
        sheetRow: o.sheetRow,
        externalId: o.external_id,
        title: o.title,
        agency: o.agency,
        stage: o.pipeline_stage,
        department: o.department,
        state: o.state,
        dueDate: o.due_date,
        bucket: scores.get(o.external_id)?.bucket ?? null,
        score: scores.get(o.external_id)?.pursuitScore ?? null,
      })),
      // Everything the mapper had to infer or could not map, by sheet row.
      issues: mapped.issues,
    });
  } catch (e) {
    if (e instanceof ImportError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    console.error("[import] failed:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "The import failed." },
      { status: 500 },
    );
  }
}
