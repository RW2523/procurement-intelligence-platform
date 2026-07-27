import { NextRequest, NextResponse } from "next/server";
import { getServiceClient, dbConfigured } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth/guard";
import { getSourceBySlug } from "@/lib/crawl/runner";
import { storeUploadedDocument } from "@/lib/crawl/attachments";
import {
  MAX_UPLOAD_REQUEST_BYTES,
  checkUploadBatch,
  checkUploadRequestSize,
  mb,
} from "@/lib/documents/limits";
import { classifyRelevanceLLM, buildProfileFromTargeting } from "@/lib/ai/relevance";
import { getTargetingProfile } from "@/lib/targeting/profile";
import { scoreOpportunity } from "@/lib/targeting/engine";
import { getCompanySettings } from "@/lib/db/settings";
import { contentHash } from "@/lib/crawl/hash";
import { departmentForOpportunity } from "@/lib/departments";
import type { NormalizedOpportunity, PipelineStage, User } from "@/lib/types";
import { PIPELINE_STAGES } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

/* ── Value parsing ────────────────────────────────────────────────────────────
 * The Pipeline_2026 sheet is hand-kept, so every "typed" cell is really free
 * text: "1.96B BPA", "07/23/26  5 PM???", "Jul 16, 2026 \r\nPre-soliciation".
 * The rule everywhere below is the same: STORE THE RAW STRING VERBATIM in the
 * *_text column, and additionally derive a typed value only when the parse is
 * unambiguous. A failed parse must never lose the user's input.
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * "$250,000" → 250000 · "1.96B BPA" → 1960000000 · "TBD" → null.
 * Only the leading number is read; trailing prose ("BPA") is ignored, which is
 * why the raw cell is kept in `estimated_value_text` as the display value.
 */
function parseMoney(raw: string): number | null {
  const m = raw.replace(/[$,\s]/g, "").match(/^([0-9]*\.?[0-9]+)([kmb])?/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase() as "k" | "m" | "b"] ?? 1;
  return n * mult;
}

const IANA: Record<string, string> = {
  E: "America/New_York",
  C: "America/Chicago",
  M: "America/Denver",
  P: "America/Los_Angeles",
};
const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];

/** Offset (ms) of `tz` at the given UTC instant — DST-correct, no dependencies. */
function tzOffsetMs(tz: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const p: Record<string, string> = {};
  for (const x of parts) p[x.type] = x.value;
  const asUTC = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second),
  );
  return asUTC - utcMs;
}

/** Wall-clock fields in `tz` → the real UTC instant (two-pass for DST edges). */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = tzOffsetMs(tz, naive);
  const off2 = tzOffsetMs(tz, naive - off1);
  return new Date(naive - off2);
}

/**
 * Best-effort parse of a hand-typed deadline into an ISO instant, or null.
 *
 * Deliberately conservative: it reads the FIRST date it finds on the first
 * date-bearing line and ignores the rest, because these cells routinely carry a
 * second thought ("04/30/2026 11:00 AM EDT\r\n6/4/26 @ 11 am", "1/16/26 2 pm
 * EST\r\n\r\nquestions should be answered by December 30, 2025"). The timezone
 * abbreviation is honoured (EST/EDT/ET/CT/CDT/…): parsing "11:59 pm CT" as if
 * it were the server's UTC clock would move a deadline by 5-6 hours, which for
 * a bid due date is the difference between "due tomorrow" and "missed".
 *
 * A date with no time defaults to 23:59 local — a deadline stated as a bare day
 * lasts until the end of that day, and midnight-start would show it as elapsed
 * a full day early.
 */
function parseDeadline(raw: string): string | null {
  const lines = raw.replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => /\d/.test(l) && /[\/\-]|\b[a-z]{3,9}\b/i.test(l));
  if (!line) return null;

  // Timezone: EST/EDT/CST/CDT/MST/MDT/PST/PDT and the bare ET/CT/MT/PT forms.
  const tzm = line.match(/\b([ECMP])[SD]?T\b/);
  const tz = IANA[tzm?.[1] ?? ""] ?? "America/New_York";

  let y: number | null = null;
  let mo: number | null = null;
  let d: number | null = null;

  let m = line.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/); // 6/4/26 · 04/30/2026
  if (m) {
    mo = Number(m[1]);
    d = Number(m[2]);
    y = Number(m[3]);
  } else if ((m = line.match(/\b(\d{1,2})[-\s]([A-Za-z]{3,9})\.?[-\s,]+(\d{2,4})\b/))) {
    // 29-Apr-26 · 16 April 2026
    d = Number(m[1]);
    mo = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
    y = Number(m[3]);
  } else if ((m = line.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/))) {
    // Jan 5, 2026 · June 18, 2026
    mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
    d = Number(m[2]);
    y = Number(m[3]);
  }
  if (!y || !mo || !d || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (y < 100) y += 2000;

  // Time — "2:00 PM", "5 PM", "3:00:00 PM", "15:00". Searched AFTER the matched
  // date text so the date's own digits cannot be read as a clock. The optional
  // seconds group is load-bearing: without it "5:00:00 PM" backtracks onto the
  // SECONDS pair and silently becomes 12:00 PM.
  let h = 23;
  let mi = 59;
  const rest = line.slice(line.indexOf(m![0]) + m![0].length);
  const t =
    rest.match(/\b(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*([ap])\.?m\.?/i) ??
    rest.match(/\b(\d{1,2}):(\d{2})\b/);
  if (t) {
    h = Number(t[1]);
    mi = t[2] ? Number(t[2]) : 0;
    const ampm = t[3]?.toLowerCase();
    if (ampm === "p" && h < 12) h += 12;
    if (ampm === "a" && h === 12) h = 0;
  }
  if (h > 23 || mi > 59) return null;

  const dt = zonedToUtc(y, mo, d, h, mi, tz);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

/** "54151S & 518210C" → ["54151S","518210C"] · "541511 Custom Computer…" → ["541511"]. */
function parseNaics(raw: string): string[] {
  const found = raw.toUpperCase().match(/\b\d{4,6}[A-Z]?\b/g) ?? [];
  return [...new Set(found)];
}

/** "SB, SBA OWSB" / "8(a) & WOSB" → ["SB","SBA OWSB"]. text[] — stays a RAW array. */
function parseList(raw: string): string[] {
  return [...new Set(raw.split(/[,;\n]|\s&\s|\s\/\s/).map((s) => s.trim()).filter(Boolean))];
}

/** ISO date (YYYY-MM-DD) for a `date` column, from a date input or a typed date. */
function parseDateOnly(raw: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const iso = parseDeadline(raw);
  return iso ? iso.slice(0, 10) : null;
}

/**
 * POST multipart/form-data — add an opportunity the team found themselves into
 * the same system as crawled ones. This is the write path behind the manual
 * entry form, and it carries all 17 columns of the user's Pipeline_2026 sheet.
 * The bid gets the full treatment: documents stored+parsed, LLM bid/no-bid
 * check, version snapshot, audit trail — and lands on the opportunity detail page.
 */
export async function POST(req: NextRequest) {
  if (!dbConfigured) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  let user: User;
  try {
    user = await requireRole("writer");
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const sb = getServiceClient();

  // ── Upload gate #1: request size, BEFORE the body is read ─────────────────
  // req.formData() materialises every part in memory, so this has to be decided
  // from the header — a check afterwards is a check after the allocation. This
  // box is 2 GB and shared with payroll; an OOM here restarts both apps.
  const oversizedRequest = checkUploadRequestSize(req.headers.get("content-length"));
  if (oversizedRequest) return NextResponse.json({ error: oversizedRequest }, { status: 413 });

  const form = await req.formData().catch(() => null);
  // The other way to land here is a body the proxy layer truncated for exceeding
  // experimental.proxyClientMaxBodySize (Next truncates silently rather than
  // failing), which leaves a valid-looking request with a corrupt multipart
  // body. The size is named so that case doesn't read as a mystery 400.
  if (!form) {
    return NextResponse.json(
      { error: `Could not read the upload. Expected multipart/form-data, up to ${mb(MAX_UPLOAD_REQUEST_BYTES)} in total.` },
      { status: 400 },
    );
  }

  // ── Upload gate #2: the attachment set, from File metadata only ───────────
  // File.size is known without touching the bytes, so an oversized or
  // unsupported document is refused before arrayBuffer() makes a second copy —
  // and before the opportunity row is inserted, so a rejected upload leaves
  // nothing half-saved and the user can simply fix the file and resubmit.
  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  const badBatch = checkUploadBatch(files);
  if (badBatch) return NextResponse.json({ error: badBatch }, { status: 413 });

  const str = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };

  const title = str("title");
  if (!title) return NextResponse.json({ error: "Title is required" }, { status: 400 });

  const source = await getSourceBySlug("manual");
  if (!source) return NextResponse.json({ error: "Manual source missing — run migrations" }, { status: 500 });

  // ── RFx # ──────────────────────────────────────────────────────────────────
  // The sheet's cell is free text and sometimes holds two numbers or a label
  // ("Notice ID\r\n6973GH-26-R-01234"). Keep it verbatim in `rfx_number_raw`
  // and derive a single clean token for the (source_id, external_id) natural key.
  const rfxRaw = str("rfx_number_raw");
  const derivedId = rfxRaw
    ?.replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop()
    ?.slice(0, 80);
  const externalId = str("external_id") ?? derivedId ?? `MANUAL-${Date.now().toString(36).toUpperCase()}`;

  // ── Capture stage ─────────────────────────────────────────────────────────
  // Validated against the 11-value vocabulary; IDENTIFIED (not REVIEWING) is
  // the default, because a row the user has just found is by definition only
  // identified. It also matches the column default in the DB.
  const stageRaw = (str("pipeline_stage") ?? "IDENTIFIED").toUpperCase().replace(/[\s-]+/g, "_");
  const stage: PipelineStage = (PIPELINE_STAGES as string[]).includes(stageRaw)
    ? (stageRaw as PipelineStage)
    : "IDENTIFIED";

  // ── Money, dates, lists — raw text always kept, typed value best-effort ────
  const estText = str("estimated_value");
  const estimatedValue = estText ? parseMoney(estText) : null;

  const dueText = str("due_date_text");
  const dueDate = str("due_date") ?? (dueText ? parseDeadline(dueText) : null);
  const qaText = str("q_and_a_deadline_text");
  const qaDeadline = str("q_and_a_deadline") ?? (qaText ? parseDeadline(qaText) : null);

  const naicsRaw = str("naics_code");
  const naicsCodes = naicsRaw ? parseNaics(naicsRaw) : [];
  const setAsidesRaw = str("set_asides");
  const setAsides = setAsidesRaw ? parseList(setAsidesRaw) : [];

  const dateFoundRaw = str("date_found");
  const dateFound = dateFoundRaw ? parseDateOnly(dateFoundRaw) : new Date().toISOString().slice(0, 10);

  const sharedRaw = str("is_shared");
  const isShared = /^(yes|true|1|share|shared)$/i.test(sharedRaw ?? "");

  const stateRaw = str("state");
  const state = stateRaw ? stateRaw.trim().toUpperCase().slice(0, 2) : null;

  const vehicle = str("contract_vehicle");

  // Department: what the user typed wins; otherwise derive it from the free-text
  // agency / POC block, which is where the sheet actually records it ("The U.S.
  // Department of the Interior\n381 ELDEN STREET…"). A null result is a normal
  // answer — the five departments are a filter, never a gate.
  const agencyText = str("agency");
  const pocRaw = str("poc_raw");
  const department =
    str("department") ?? departmentForOpportunity(agencyText ?? pocRaw, title);

  const normalized: NormalizedOpportunity = {
    externalId,
    title,
    agency: agencyText,
    category: str("category"),
    naicsCode: naicsCodes[0] ?? naicsRaw,
    description: str("description"),
    postedDate: str("posted_date"),
    dueDate,
    qAndADeadline: qaDeadline,
    estimatedValue,
    detailUrl: str("detail_url"),
    statusOnSite: "manual",
  };

  // Duplicate guard on the natural key (source_id, external_id).
  const { data: dup } = await sb
    .from("opportunities")
    .select("id")
    .eq("source_id", source.id)
    .eq("external_id", externalId)
    .maybeSingle();
  if (dup) {
    return NextResponse.json(
      { error: `A bid with number "${externalId}" already exists in My Bids`, id: dup.id },
      { status: 409 },
    );
  }

  const { data: inserted, error } = await sb
    .from("opportunities")
    .insert({
      source_id: source.id,
      external_id: externalId,
      title,
      agency: normalized.agency,
      category: normalized.category,
      naics_code: normalized.naicsCode,
      description: normalized.description,
      posted_date: normalized.postedDate ? normalized.postedDate.slice(0, 10) : null,
      due_date: normalized.dueDate,
      q_and_a_deadline: normalized.qAndADeadline,
      estimated_value: estimatedValue,
      detail_url: normalized.detailUrl,
      status: "OPEN",
      pipeline_stage: stage,
      content_hash: contentHash(normalized),
      assigned_to: user.id,

      // Pipeline_2026 columns. `set_asides` and `naics_codes` are text[] and are
      // bound as RAW JS arrays — they are deliberately absent from the JSONB map
      // in src/lib/db/query.ts; stringifying them yields "malformed array literal".
      is_shared: isShared,
      date_found: dateFound,
      department,
      sub_agency: str("sub_agency"),
      state,
      poc_raw: pocRaw,
      poc_name: str("poc_name"),
      poc_email: str("poc_email"),
      poc_phone: str("poc_phone"),
      rfx_number_raw: rfxRaw,
      naics_codes: naicsCodes,
      set_asides: setAsides,
      contract_vehicle: vehicle,
      period_of_performance: str("period_of_performance"),
      estimated_value_text: estText,
      q_and_a_deadline_text: qaText,
      due_date_text: dueText,
      capture_notes: str("capture_notes"),
      outcome: str("outcome"),
      lessons_learned: str("lessons_learned"),
    })
    .select("id")
    .single();
  if (error || !inserted) {
    return NextResponse.json({ error: `Failed to save bid: ${error?.message}` }, { status: 500 });
  }
  const oppId = inserted.id as string;

  await sb.from("opportunity_versions").insert({
    opportunity_id: oppId,
    version_no: 1,
    snapshot_json: normalized as unknown as Record<string, unknown>,
    content_hash: contentHash(normalized),
    change_summary: "Uploaded by team (current pipeline)",
  });
  await sb.from("opportunity_status_log").insert({
    opportunity_id: oppId,
    field: "status",
    old_value: null,
    new_value: "OPEN",
    changed_by: str("added_by") ?? user.name,
    reason: "Bid uploaded manually — existing pipeline",
  });
  await sb.from("opportunity_status_log").insert({
    opportunity_id: oppId,
    field: "pipeline_stage",
    old_value: null,
    new_value: stage,
    changed_by: str("added_by") ?? user.name,
    reason: "Capture stage set on manual entry",
  });

  // Store uploaded documents (bytes + extracted text → same gate as crawled docs).
  // The set was validated above, so anything refused here is a CONTENT mismatch
  // the metadata could not reveal (an .pdf that isn't a PDF, an HTML error page
  // saved as .docx). The bid is already saved, so these are reported back rather
  // than failing the request — and reported, not swallowed.
  let stored = 0;
  const rejected: string[] = [];
  for (const f of files) {
    const buf = Buffer.from(await f.arrayBuffer());
    const r = await storeUploadedDocument(oppId, f.name || "document", buf, f.type || "");
    if (r.status === "stored") stored++;
    else rejected.push(r.reason);
  }

  // Targeting engine + LLM bid/no-bid check — same treatment as crawled items,
  // including the text of the documents just uploaded.
  let scored = false;
  try {
    const [company, targeting, { data: atts }] = await Promise.all([
      getCompanySettings(),
      getTargetingProfile(),
      sb.from("attachments").select("parsed_text").eq("opportunity_id", oppId),
    ]);
    const docText = (atts ?? []).map((a) => a.parsed_text).filter(Boolean).join("\n\n");
    const engine = scoreOpportunity(
      {
        title,
        description: normalized.description,
        category: normalized.category,
        agency: normalized.agency,
        naicsCode: normalized.naicsCode,
        docText: docText || null,
        dueDate: normalized.dueDate ?? null,
        estimatedValue,
      },
      targeting,
    );
    await sb
      .from("opportunities")
      .update({
        pursuit_score: engine.pursuitScore,
        pursuit_bucket: engine.bucket,
        urgency: engine.urgency,
        // What the USER typed wins over what the engine sniffed out of the text:
        // these two are columns on their spreadsheet, not derived signals.
        set_asides: setAsides.length ? setAsides : engine.setAsides,
        contract_vehicle: vehicle ?? engine.contractVehicle,
        solicitation_type: engine.solicitationType,
        agency_priority: engine.agencyPriority,
        excluded_reason: engine.excludedReason,
        score_breakdown: engine.breakdown as unknown as Record<string, unknown>[],
        relevance_score: Math.min(100, engine.pursuitScore),
        relevance_reason:
          engine.breakdown.filter((b) => b.points > 0).slice(0, 4).map((b) => `${b.criterion} +${b.points}`).join(" · ") ||
          "No targeting criteria matched",
        relevance_method: "engine",
      })
      .eq("id", oppId);

    const verdicts = await classifyRelevanceLLM(
      [
        {
          id: oppId,
          title,
          agency: normalized.agency,
          category: normalized.category,
          description: normalized.description || docText.slice(0, 320) || null,
          naicsCode: normalized.naicsCode,
        },
      ],
      buildProfileFromTargeting(company, targeting),
    );
    const v = verdicts.get(oppId);
    if (v) {
      await sb
        .from("opportunities")
        .update({
          relevance_score: v.score,
          relevance_reason: v.reason,
          bid_recommendation: v.recommendation,
          relevance_method: "llm",
        })
        .eq("id", oppId);
      scored = true;
    }
  } catch {
    /* scoring is best-effort; the bid is already saved */
  }

  // Mark documents checked so backfills skip this manual bid.
  await sb.from("opportunities").update({ documents_checked_at: new Date().toISOString() }).eq("id", oppId);

  return NextResponse.json({
    id: oppId,
    externalId,
    documents: { stored, rejected },
    scored,
  });
}
