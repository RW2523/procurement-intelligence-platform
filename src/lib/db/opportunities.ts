import { getServiceClient } from "@/lib/supabase/server";
import type {
  Attachment,
  Opportunity,
  OpportunityVersion,
  OpportunityView,
  PipelineStage,
  StatusLogEntry,
} from "@/lib/types";

export interface OppFilters {
  q?: string;
  /** USPS code, e.g. "NC". Case-insensitive — see the state block below. */
  state?: string;
  status?: string;
  /** Pipeline stage (IDENTIFIED, QUALIFYING, … WON, LOST). */
  stage?: string;
  /**
   * Parent department code, applied in SQL against opportunities.department.
   * The five PRIORITY codes ("DOT", "DOI", "DOE", "VA", "HHS") come from
   * src/lib/departments.ts; the column deliberately has no CHECK constraint and
   * also carries the non-priority codes the importer writes (DOJ, GSA, DOD…),
   * so this is a plain equality on whatever is stored.
   */
  department?: string;
  sourceId?: string;
  relevanceMin?: number;
  assignedTo?: string;
  /** Targeting-engine bucket: one bucket, or "ACTIONABLE" = PURSUE + CAPTURE_REVIEW. */
  bucket?: string;
  urgency?: string;
  /** Set-aside label prefix ("8(a)", "WOSB"…) or "ANY" = any detected set-aside. */
  setAside?: string;
  /** Contract vehicle ("GSA MAS", "Task Order"…) or "ANY" = any detected vehicle. */
  vehicle?: string;
  /** Minimum calendar days until due (the §10 "at least 10 days out" rule). */
  minDays?: number;
  /**
   * Exempt HAND-ENTERED rows (the 'manual' source) from the engine's triage
   * gates — `bucket: "ACTIONABLE"` and `minDays`. See HAND_ENTERED_SLUG below
   * for why the default shortlist has to do this. Off by default: a caller
   * asking for one specific bucket is asking about engine output and must get
   * engine output.
   */
  includeHandEntered?: boolean;
  /** Restrict to open statuses (NEW/OPEN/AMENDED/CLOSING_SOON). */
  openOnly?: boolean;
  /** due_date >= this ISO timestamp. */
  dueFrom?: string;
  /** due_date <= this ISO timestamp. */
  dueBefore?: string;
  sort?: "due_date" | "relevance" | "newest" | "score";
  limit?: number;
}

const OPEN_STATUSES = ["NEW", "OPEN", "AMENDED", "CLOSING_SOON"];

/**
 * `sources.slug` of the pseudo-source every HAND-ENTERED row hangs off — the row
 * seeded by deploy/db/seed-sources.sql, the one "My Bids" posts to
 * (src/app/api/bids/route.ts) and the one scripts/import-pipeline-xlsx.mts loads
 * the operator's workbook into.
 *
 * WHY THE DEFAULT LIST HAS TO KNOW ABOUT IT. `pursuit_bucket` is a TRIAGE verdict:
 * its job is to cut thousands of crawled listings down to the handful worth a
 * human's attention. That is the right gate for a row nobody has looked at. It is
 * the wrong gate for a row a human TYPED IN — that row has already passed the only
 * triage that matters, and the engine's opinion of it is commentary, not a
 * gatekeeper. Scoring hand-entered rows (which the importer now does, so they
 * carry a bucket, a score and an urgency like any crawled row) does NOT fix this
 * on its own: measured over the operator's real 71-row workbook the engine tops
 * out at 48 points against a captureReview threshold of 60, so every single row
 * buckets IGNORE/MANUAL_REVIEW and the default page renders "0 opportunities".
 * The operator then opens the department filter and sees nothing, which is the
 * bug this exemption exists to fix.
 */
const HAND_ENTERED_SLUG = "manual";

/**
 * The 'manual' source id, or null when the caller did not ask for the exemption
 * (or the seed row is missing). Resolved to an id up front for the same reason
 * the state block below does it: the builder cannot filter on an embedded
 * resource, so `source.slug` has to become `source_id`.
 */
async function handEnteredSourceId(
  sb: ReturnType<typeof getServiceClient>,
  wanted: boolean,
): Promise<string | null> {
  if (!wanted) return null;
  const { data } = await sb.from("sources").select("id").eq("slug", HAND_ENTERED_SLUG).maybeSingle();
  const id = (data as { id?: string } | null)?.id ?? null;
  // or() builds a parsed expression string, so only a uuid-shaped value is ever
  // interpolated into it — same rule as the source ids in the state block.
  return id && /^[0-9a-fA-F-]{36}$/.test(id) ? id : null;
}

const EMBED =
  "*, source:sources!opportunities_source_id_fkey(id,name,slug,state), " +
  "assignee:users!opportunities_assigned_to_fkey(id,name), " +
  "responses(count), attachments(count), opportunity_versions(count)";

function shape(row: Record<string, unknown>): OpportunityView {
  const r = row as unknown as OpportunityView & {
    responses?: { count: number }[];
    attachments?: { count: number }[];
    opportunity_versions?: { count: number }[];
  };
  return {
    ...(row as unknown as OpportunityView),
    response_count: r.responses?.[0]?.count ?? 0,
    attachment_count: r.attachments?.[0]?.count ?? 0,
    version_count: r.opportunity_versions?.[0]?.count ?? 0,
  };
}

export async function listOpportunities(filters: OppFilters = {}): Promise<OpportunityView[]> {
  const sb = getServiceClient();
  let q = sb.from("opportunities").select(EMBED);

  if (filters.status) q = q.eq("status", filters.status);
  if (filters.openOnly) q = q.in("status", OPEN_STATUSES);
  if (filters.dueFrom) q = q.gte("due_date", filters.dueFrom);
  if (filters.dueBefore) q = q.lte("due_date", filters.dueBefore);
  if (filters.stage) q = q.eq("pipeline_stage", filters.stage);
  if (filters.department) q = q.eq("department", filters.department);
  if (filters.sourceId) q = q.eq("source_id", filters.sourceId);
  if (filters.assignedTo) q = q.eq("assigned_to", filters.assignedTo);
  if (filters.relevanceMin != null) q = q.gte("relevance_score", filters.relevanceMin);
  // Hand-entered rows skip the two triage gates below. Each gate is ONE or()
  // group and separate or() groups are AND-ed, so the escape term has to appear
  // in every gate it should open — a row that clears the bucket gate but not the
  // date gate is still filtered out.
  const handEntered = await handEnteredSourceId(sb, filters.includeHandEntered === true);
  const escape = handEntered ? [`source_id.eq.${handEntered}`] : [];

  if (filters.bucket === "ACTIONABLE") {
    // Written as eq terms rather than in(): or() has to carry the escape term
    // and the builder's OR grammar takes only comparison operators.
    q = q.or(["pursuit_bucket.eq.PURSUE", "pursuit_bucket.eq.CAPTURE_REVIEW", ...escape].join(","));
  } else if (filters.bucket === "INSUFFICIENT_TIME") q = q.eq("urgency", "INSUFFICIENT_TIME");
  else if (filters.bucket) q = q.eq("pursuit_bucket", filters.bucket);
  if (filters.urgency) q = q.eq("urgency", filters.urgency);
  if (filters.setAside === "ANY") q = q.neq("set_asides", "{}");
  if (filters.vehicle === "ANY") q = q.not("contract_vehicle", "is", null);
  else if (filters.vehicle) q = q.eq("contract_vehicle", filters.vehicle);
  // ── minDays ──────────────────────────────────────────────────────────────
  // §10: don't show work there is provably not enough time to bid. This used to
  // be a bare `due_date >= cutoff`, and that is a NULL trap: for a row with no
  // due date the comparison is NULL, NULL is not TRUE, and the row silently
  // vanished. Four of the operator's 71 hand-typed rows have no parseable
  // deadline and disappeared exactly this way.
  //
  // THE DECISION: a row with NO due date is INCLUDED.
  //   · minDays excludes what is provably too late. "No deadline recorded" is not
  //     proof of anything — it is missing information, and the two are different
  //     facts. The engine already models them as different facts: urgency
  //     INSUFFICIENT_TIME vs NO_DATE are separate bands (src/lib/targeting/engine.ts
  //     urgencyFor()). The filter should not collapse them.
  //   · The failure modes are not symmetric. Showing a row whose deadline nobody
  //     has found yet costs the operator one glance and gives them the chance to
  //     go and find it; hiding it costs the bid, silently, with no UI anywhere
  //     that would reveal the row was suppressed.
  //   · So it is spelled out as an explicit disjunct rather than left to fall out
  //     of three-valued logic in either direction.
  //
  // `urgency = 'NO_DATE'` is the disjunct, not `due_date is null`, because the
  // builder's OR grammar has no null test. It is a faithful stand-in and not a
  // second source of truth: urgency is written by the same engine pass that
  // writes pursuit_bucket, from the same due_date, and it is NOT NULL for every
  // scored row — and an unscored row has no bucket, so it never reaches here
  // through the ACTIONABLE/PURSUE/CAPTURE_REVIEW views that pass minDays. Nor
  // can it go stale the way a cached day-count would: "this row has no deadline"
  // stops being true only when a deadline is added, and both the crawler
  // (AMENDED update) and the rescore route rewrite urgency when that happens.
  if (filters.minDays != null) {
    const cutoff = new Date(Date.now() + filters.minDays * 86_400_000).toISOString();
    q = q.or([`due_date.gte.${cutoff}`, "urgency.eq.NO_DATE", ...escape].join(","));
  }
  // ── State ────────────────────────────────────────────────────────────────
  // Now applied IN SQL, and case-insensitively, replacing a JS post-filter.
  //
  // Two bugs were fixed here at once:
  //  1. The post-filter ran AFTER `q.limit()`, so "?state=MA" returned only the
  //     MA rows that happened to land in the global top-N by pursuit_score. If
  //     MA's opportunities all scored below the cut, the page looked empty even
  //     though matching rows existed — and the count badge under-reported.
  //  2. It compared with `===`. Every seeded source stores an UPPERCASE state,
  //     but createSource() writes AddSourceForm's free-text box verbatim, so a
  //     hand-added "nc" was invisible to the "NC" option. ilike fixes that
  //     without needing a data migration.
  //
  // State lives in two places and a row may use either: `sources.state` for
  // crawled rows, and `opportunities.state` for hand-entered ones (the 'manual'
  // source is seeded with state = null, so typed-in rows had no state at all).
  // The query builder cannot filter on an embedded resource, so the source side
  // is resolved to ids first and OR'd in.
  const stateCode = filters.state?.replace(/[^A-Za-z]/g, "") ?? "";
  if (stateCode) {
    const { data: srcRows } = await sb.from("sources").select("id").ilike("state", stateCode);
    const srcIds = ((srcRows ?? []) as { id: string }[])
      .map((s) => s.id)
      // The or() expression is a parsed string, so only bind values that cannot
      // disturb it. Anything not uuid-shaped is dropped rather than trusted.
      .filter((id) => /^[0-9a-fA-F-]{36}$/.test(id));
    q = q.or([`state.ilike.${stateCode}`, ...srcIds.map((id) => `source_id.eq.${id}`)].join(","));
  }
  if (filters.q) {
    const term = filters.q.replace(/[%,]/g, " ");
    q = q.or(`title.ilike.%${term}%,agency.ilike.%${term}%,external_id.ilike.%${term}%`);
  }

  if (filters.sort === "relevance") q = q.order("relevance_score", { ascending: false, nullsFirst: false });
  else if (filters.sort === "score") q = q.order("pursuit_score", { ascending: false, nullsFirst: false });
  else if (filters.sort === "due_date") q = q.order("due_date", { ascending: true, nullsFirst: false });
  else q = q.order("first_seen_at", { ascending: false });

  q = q.limit(filters.limit ?? 300);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  let rows = ((data ?? []) as unknown as Record<string, unknown>[]).map(shape);
  // (state is now filtered in SQL above — see the note there)
  // specific set-aside labels are prefix-matched against the detected array
  if (filters.setAside && filters.setAside !== "ANY") {
    rows = rows.filter((r) => r.set_asides?.some((s) => s.startsWith(filters.setAside!)));
  }
  return rows;
}

export async function getOpportunity(id: string): Promise<OpportunityView | null> {
  const sb = getServiceClient();
  const { data } = await sb.from("opportunities").select(EMBED).eq("id", id).maybeSingle();
  return data ? shape(data as unknown as Record<string, unknown>) : null;
}

// Never select file_base64 here — the bytes are streamed only via /api/attachments/:id/file.
const ATTACHMENT_COLS =
  "id, opportunity_id, filename, source_url, storage_url, file_type, content_type, " +
  "byte_size, parse_status, fetch_error, downloaded_at, created_at";

export async function getAttachments(opportunityId: string): Promise<Attachment[]> {
  const sb = getServiceClient();
  const { data } = await sb
    .from("attachments")
    .select(ATTACHMENT_COLS)
    .eq("opportunity_id", opportunityId)
    .order("created_at");
  return (data ?? []) as unknown as Attachment[];
}

export async function getVersions(opportunityId: string): Promise<OpportunityVersion[]> {
  const sb = getServiceClient();
  const { data } = await sb
    .from("opportunity_versions")
    .select("*")
    .eq("opportunity_id", opportunityId)
    .order("version_no", { ascending: false });
  return (data ?? []) as OpportunityVersion[];
}

export async function getStatusLog(opportunityId: string): Promise<StatusLogEntry[]> {
  const sb = getServiceClient();
  const { data } = await sb
    .from("opportunity_status_log")
    .select("*")
    .eq("opportunity_id", opportunityId)
    .order("changed_at", { ascending: false });
  return (data ?? []) as StatusLogEntry[];
}

export async function updateOppStatus(
  id: string,
  field: "status" | "pipeline_stage",
  value: string,
  changedBy = "user",
  reason?: string,
): Promise<void> {
  const sb = getServiceClient();
  const { data: current } = await sb.from("opportunities").select(field).eq("id", id).single();
  const old = (current as Record<string, string> | null)?.[field] ?? null;
  if (old === value) return;
  const patch: Record<string, unknown> = { [field]: value };
  if (field === "status" && ["CLOSED", "REMOVED", "CANCELLED", "AWARDED"].includes(value)) {
    patch.closed_at = new Date().toISOString();
  }
  await sb.from("opportunities").update(patch).eq("id", id);
  await sb.from("opportunity_status_log").insert({
    opportunity_id: id,
    field,
    old_value: old,
    new_value: value,
    changed_by: changedBy,
    reason: reason ?? null,
  });
}

export async function assignOpportunity(id: string, userId: string | null): Promise<void> {
  const sb = getServiceClient();
  await sb.from("opportunities").update({ assigned_to: userId }).eq("id", id);
}

/** Opportunities grouped by pipeline stage for the Kanban board. */
export async function getBoard(): Promise<Record<PipelineStage, OpportunityView[]>> {
  const rows = await listOpportunities({ sort: "due_date", limit: 500 });
  const board = {} as Record<PipelineStage, OpportunityView[]>;
  for (const r of rows) {
    (board[r.pipeline_stage] ??= []).push(r);
  }
  return board;
}

/**
 * Write operator-supplied detail onto a bid.
 *
 * Used by the "missing details" editor. Only the columns in EDITABLE_KEYS are
 * accepted and each is bound as a parameter — the patch arrives from a form, so
 * a stray key must never become a column name. Empty strings are stored as NULL
 * so a cleared field reads as missing again rather than as an empty answer.
 */
export async function updateBidDetails(
  id: string,
  patch: Record<string, unknown>,
): Promise<{ updated: string[] }> {
  const { EDITABLE_KEYS } = await import("@/lib/bids/completeness");
  const allowed = new Set<string>(EDITABLE_KEYS as readonly string[]);

  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, raw] of Object.entries(patch)) {
    if (!allowed.has(k)) continue;
    let v = raw;
    if (typeof v === "string" && v.trim() === "") v = null;
    if (k === "estimated_value" && v !== null) {
      const n = Number(String(v).replace(/[^0-9.]/g, ""));
      v = Number.isFinite(n) ? n : null;
    }
    if (k === "set_asides" && typeof v === "string") {
      v = v.split(",").map((s) => s.trim()).filter(Boolean);
    }
    sets.push(k);
    vals.push(v);
  }
  if (!sets.length) return { updated: [] };

  const { sql } = await import("@/lib/db/pg");
  await sql(
    `update public.opportunities
        set ${sets.map((c, i) => `"${c}" = $${i + 1}`).join(", ")}, updated_at = now()
      where id = $${sets.length + 1}`,
    [...vals, id],
  );
  return { updated: sets };
}
