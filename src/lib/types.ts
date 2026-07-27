/**
 * Domain types — the shared contract for DB rows, connector output, and view models.
 * Kept hand-written (rather than generated) so the whole codebase reads against
 * one stable vocabulary.
 */

// ── Enums (mirror the Postgres enums) ────────────────────────────────────────
export type UserRole = "admin" | "writer" | "approver" | "viewer";
/** Least- to most-privileged. Drives the role pickers and validates untrusted input. */
export const USER_ROLES: UserRole[] = ["viewer", "writer", "approver", "admin"];

export type OppStatus =
  | "NEW"
  | "OPEN"
  | "AMENDED"
  | "CLOSING_SOON"
  | "CLOSED"
  | "REMOVED"
  | "AWARDED"
  | "CANCELLED";

/**
 * Capture & proposal phases, in the order the team works them.
 *
 * This is the TEAM's axis: where WE are on a pursuit. It is NOT `OppStatus`,
 * which is the SOLICITATION's own lifecycle as reported by the portal — in
 * particular OppStatus 'AWARDED' means the agency awarded to *someone*
 * (possibly a competitor), whereas PipelineStage 'WON' means we won it.
 *
 * Retired vocabulary (pre-2026 rows) and its migration mapping, see
 * deploy/db/migrations/001-pipeline-2026.sql:
 *   BACKLOG → IDENTIFIED · DRAFTING → PURSUING · DECLINED → NO_BID
 */
export type PipelineStage =
  | "IDENTIFIED"
  | "QUALIFYING"
  | "PURSUING"
  | "NO_BID"
  | "REVIEWING"
  | "APPROVED"
  | "SUBMITTED"
  | "ORALS"
  | "BAFO"
  | "WON"
  | "LOST";

export type ResponseMode = "STYLE_MATCHED" | "LLM_ORIGINAL";
export type ResponseStatus = "DRAFT" | "IN_REVIEW" | "APPROVED" | "SUBMITTED" | "REJECTED";

export type ConnectorType =
  | "json_api"
  | "static_html"
  | "aspnet_viewstate"
  | "jsf_playwright"
  | "playwright"
  | "custom";

export type SourceStatus = "active" | "paused" | "error" | "needs_connector";

export type NotificationType =
  | "NEW_OPPORTUNITY"
  | "AMENDMENT"
  | "DEADLINE"
  | "QA_DEADLINE"
  | "CRAWL_FAILURE"
  | "RESPONSE_APPROVED"
  | "STATUS_CHANGE";

export type KnowledgeOutcome = "won" | "lost" | "unknown";

/** LLM bid/no-bid verdict for a solicitation against the company profile. */
export type BidRecommendation = "BID" | "REVIEW" | "NO_BID";

/** Weighted targeting-engine buckets (§9 thresholds: 80+/60–79/40–59/<40). */
export type PursuitBucket = "PURSUE" | "CAPTURE_REVIEW" | "MANUAL_REVIEW" | "IGNORE";

/** Due-date urgency bands (§10: <10 insufficient, 10–20 urgent, 21–45 standard, 46+ early). */
export type UrgencyBand = "URGENT" | "STANDARD" | "EARLY_CAPTURE" | "INSUFFICIENT_TIME" | "NO_DATE";

export const PURSUIT_BUCKETS: PursuitBucket[] = ["PURSUE", "CAPTURE_REVIEW", "MANUAL_REVIEW", "IGNORE"];

/** One line of the "why this score" panel: a criterion that fired and its evidence. */
export interface ScoreBreakdownEntry {
  criterion: string;
  points: number;
  matched: string[];
  note?: string;
}

// ── Targeting profile (the five-dimension search configuration) ─────────────
export interface CapabilityGroup {
  key: string;
  label: string;
  points: number;
  phrases: string[];
}

export interface SetAsideTier {
  label: string;
  points: number;
  terms: string[];
}

export interface ValueBand {
  /** Upper bound (exclusive) in USD; the last band uses Infinity via null. */
  maxUsd: number | null;
  points: number;
  label: string;
}

export interface TargetingProfile {
  version: number;
  /** Dimension 2a–2c: capability groups; labor categories & technologies map into them. */
  capabilities: CapabilityGroup[];
  laborCategories: { title: string; group: string }[];
  technologies: { term: string; group: string }[];
  /** Dimension 1b: functional areas ("many agencies don't describe by technology"). */
  functionalAreas: { points: number; phrases: string[] };
  /** Dimension 3: contract vehicles. */
  vehicles: { gsaMasPoints: number; otherPoints: number; gsaTerms: string[]; otherTerms: string[] };
  solicitationTypes: { term: string; points: number }[];
  /** Dimension 4: socioeconomic set-asides, tiered. */
  setAsides: SetAsideTier[];
  /** Metadata: priority agencies. */
  agencies: {
    federalPoints: number;
    statePoints: number;
    federal: { name: string; aliases: string[]; itOnly?: boolean }[];
    states: string[];
  };
  /** Dimension 5: exclusions. */
  exclusions: { group: string; terms: string[] }[];
  naics: { codes: string[]; points: number };
  valueBands: ValueBand[];
  thresholds: { pursue: number; captureReview: number; manualReview: number };
  dateBands: { minDays: number; urgentMax: number; standardMax: number };
}

/**
 * Board-column order, <select> option order and analytics bar order — all three
 * read this array, so its ORDER is the product decision, not an implementation
 * detail. The declared type stays `PipelineStage[]` because ~6 call sites do
 * `.includes()` / `.map()` against it; the exhaustiveness net is the
 * `_PIPELINE_STAGES_EXHAUSTIVE` check below, NOT the annotation.
 */
const PIPELINE_STAGE_ORDER = [
  "IDENTIFIED",
  "QUALIFYING",
  "PURSUING",
  "NO_BID",
  "REVIEWING",
  "APPROVED",
  "SUBMITTED",
  "ORALS",
  "BAFO",
  "WON",
  "LOST",
] as const satisfies readonly PipelineStage[];

export const PIPELINE_STAGES: PipelineStage[] = [...PIPELINE_STAGE_ORDER];

/**
 * Compile-time guarantee that PIPELINE_STAGE_ORDER lists EVERY PipelineStage.
 * The `PipelineStage[]` annotation alone does NOT catch a missing member — a
 * dropped stage would simply never render as a board column, a dropdown option
 * or an analytics bar, with a green build. Add a stage to the union and forget
 * the array and this line fails with "Type 'X' is not assignable to 'never'".
 * (`satisfies` above covers the other direction: no non-stage may appear.)
 */
type _PipelineStagesMissing = Exclude<PipelineStage, (typeof PIPELINE_STAGE_ORDER)[number]>;
const _PIPELINE_STAGES_EXHAUSTIVE: [_PipelineStagesMissing] extends [never]
  ? true
  : { ERROR_stage_missing_from_PIPELINE_STAGE_ORDER: _PipelineStagesMissing } = true;
void _PIPELINE_STAGES_EXHAUSTIVE;

/**
 * ── Outcome partition of PipelineStage ───────────────────────────────────────
 *
 * Analytics asks two questions of a stage that the ORDER above cannot answer:
 * "has this bid gone out the door?" and "has the agency decided?". Answering
 * them by hand-testing `stage === "SUBMITTED"` is what previously dropped ORALS
 * and BAFO out of the win-rate and outcomes-by-bucket tables entirely — both
 * are POST-submission, so a bid that advanced past Submitted was counted as
 * neither submitted nor decided until it landed on Won/Lost.
 *
 * Every stage belongs to exactly one of the three sets below, enforced at
 * compile time by `_STAGE_OUTCOME_EXHAUSTIVE`. Add a stage to the union and you
 * MUST classify it here or the build fails — that is the point.
 */

/** Never submitted. NO_BID is terminal but nothing was ever sent, so it lives here. */
const PRE_SUBMISSION_STAGE_LIST = [
  "IDENTIFIED",
  "QUALIFYING",
  "PURSUING",
  "NO_BID",
  "REVIEWING",
  "APPROVED",
] as const satisfies readonly PipelineStage[];

/** Submitted and awaiting the agency's decision. Orals and BAFO are post-submission rounds. */
const IN_FLIGHT_STAGE_LIST = ["SUBMITTED", "ORALS", "BAFO"] as const satisfies readonly PipelineStage[];

/** The agency decided. These are the only stages that feed a win rate. */
const DECIDED_STAGE_LIST = ["WON", "LOST"] as const satisfies readonly PipelineStage[];

export const PRE_SUBMISSION_STAGES: PipelineStage[] = [...PRE_SUBMISSION_STAGE_LIST];
export const IN_FLIGHT_STAGES: PipelineStage[] = [...IN_FLIGHT_STAGE_LIST];
export const DECIDED_STAGES: PipelineStage[] = [...DECIDED_STAGE_LIST];

const IN_FLIGHT_SET: ReadonlySet<string> = new Set<string>(IN_FLIGHT_STAGE_LIST);
const DECIDED_SET: ReadonlySet<string> = new Set<string>(DECIDED_STAGE_LIST);

/** True once the bid has been submitted but before the agency has decided (Submitted/Orals/BAFO). */
export function isInFlightStage(stage: string): boolean {
  return IN_FLIGHT_SET.has(stage);
}

/** True once the agency has decided (Won/Lost). */
export function isDecidedStage(stage: string): boolean {
  return DECIDED_SET.has(stage);
}

/**
 * True if the bid was ever sent to the agency — in flight OR already decided.
 * Use for "how many bids have we submitted, ever"; use `isInFlightStage` for
 * "how many are we currently waiting on".
 */
export function isSubmittedStage(stage: string): boolean {
  return IN_FLIGHT_SET.has(stage) || DECIDED_SET.has(stage);
}

/** Compile-time guarantee that the three sets partition PipelineStage (no stage unclassified). */
type _StageOutcomeMissing = Exclude<
  PipelineStage,
  | (typeof PRE_SUBMISSION_STAGE_LIST)[number]
  | (typeof IN_FLIGHT_STAGE_LIST)[number]
  | (typeof DECIDED_STAGE_LIST)[number]
>;
const _STAGE_OUTCOME_EXHAUSTIVE: [_StageOutcomeMissing] extends [never]
  ? true
  : { ERROR_stage_not_classified_as_pre_submission_in_flight_or_decided: _StageOutcomeMissing } = true;
void _STAGE_OUTCOME_EXHAUSTIVE;

export const OPP_STATUSES: OppStatus[] = [
  "NEW",
  "OPEN",
  "AMENDED",
  "CLOSING_SOON",
  "CLOSED",
  "REMOVED",
  "AWARDED",
  "CANCELLED",
];

// ── DB row types ─────────────────────────────────────────────────────────────
export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  avatar_url: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Source {
  id: string;
  name: string;
  slug: string;
  state: string | null;
  base_url: string;
  connector_type: ConnectorType;
  connector_key: string | null;
  schedule_cron: string;
  timezone: string;
  requires_auth: boolean;
  credential_ref: string | null;
  is_active: boolean;
  status: SourceStatus;
  notes: string | null;
  last_run_at: string | null;
  last_success_at: string | null;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
}

export interface Opportunity {
  id: string;
  source_id: string;
  external_id: string;
  title: string;
  agency: string | null;
  category: string | null;
  naics_code: string | null;
  description: string | null;
  posted_date: string | null;
  due_date: string | null;
  q_and_a_deadline: string | null;
  estimated_value: number | null;
  detail_url: string | null;
  status: OppStatus;
  pipeline_stage: PipelineStage;
  relevance_score: number | null;
  relevance_reason: string | null;
  /** LLM bid/no-bid verdict tuned to the company profile. */
  bid_recommendation: BidRecommendation | null;
  /** Which scorer produced the current relevance fields: 'keyword' | 'llm'. */
  relevance_method: string;
  /** Weighted targeting-engine outputs (docs/TARGETING-ENGINE-PLAN.md). */
  pursuit_score: number | null;
  pursuit_bucket: PursuitBucket | null;
  urgency: UrgencyBand | null;
  set_asides: string[];
  contract_vehicle: string | null;
  solicitation_type: string | null;
  agency_priority: boolean;
  excluded_reason: string | null;
  score_breakdown: ScoreBreakdownEntry[] | null;

  // ── Pipeline_2026 spreadsheet fields (hand-entered; NEVER written by the
  //    crawler — see the warning on src/lib/crawl/pipeline.ts's `fields` object) ──
  /** Sheet "Share/No Share" — is this pursuit shared with partners/teaming. */
  is_shared: boolean;
  /** Sheet "Date found" — the human's own discovery date. NOT `first_seen_at`,
   *  which is the row's DB creation time and drives the default list sort. */
  date_found: string | null;
  /** Parent department, e.g. 'DOT'. Populated by src/lib/departments.ts. */
  department: string | null;
  /** Operating administration under `department`, e.g. 'FAA' in "DOT/FAA". */
  sub_agency: string | null;
  /** USPS code for hand-entered rows, whose source ('manual') has state = null. */
  state: string | null;
  /** Sheet "Agency/POC" verbatim — multi-line contact block. Kept out of
   *  `agency`, which is trigram-indexed and matched by the targeting engine. */
  poc_raw: string | null;
  poc_name: string | null;
  poc_email: string | null;
  poc_phone: string | null;
  /** Sheet "RFx #" verbatim; the cleaned token goes to `external_id`. */
  rfx_number_raw: string | null;
  /** text[] — cells hold multiple codes ("54151S & 518210C"). MUST stay a raw
   *  JS array: it is NOT in the JSONB map in src/lib/db/query.ts and must not be. */
  naics_codes: string[];
  period_of_performance: string | null;
  /** Sheet "Estimated Value" verbatim ("1.96B BPA"). `estimated_value` stays
   *  numeric for scoring/summing and is null when the cell will not parse. */
  estimated_value_text: string | null;
  q_and_a_deadline_text: string | null;
  due_date_text: string | null;
  /** Sheet "Status" — a free-text capture/follow-up log. Deliberately NOT named
   *  `status`: that is the solicitation-lifecycle enum and ~15 call sites filter on it. */
  capture_notes: string | null;
  /** Sheet "Won/Loss" — free text ('Lost', 'in evalution', 'RFI no response').
   *  A separate axis from pipeline_stage; do not derive one from the other. */
  outcome: string | null;
  lessons_learned: string | null;

  content_hash: string;
  assigned_to: string | null;
  first_seen_at: string;
  last_seen_at: string;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Opportunity joined with its source + counts, used across list/detail views. */
export interface OpportunityView extends Opportunity {
  source?: Pick<Source, "id" | "name" | "slug" | "state"> | null;
  attachment_count?: number;
  response_count?: number;
  version_count?: number;
  assignee?: Pick<User, "id" | "name"> | null;
}

/**
 * A row of the "Forecased Opportunities" [sic] sheet: an agency forecast entry
 * that has NOT been solicited yet.
 *
 * Deliberately its own table rather than a flag on `opportunities`: a forecast
 * item has no solicitation number, no source, no due date, no status and no
 * stage — every one of which is not-null or CHECK-constrained on that table.
 * `promoted_opportunity_id` records the real workflow (forecast → real bid).
 */
export interface ForecastOpportunity {
  id: string;
  /** Sheet "Date Found". */
  date_found: string | null;
  /** Sheet "Agency" — the parent department, e.g. 'DOT'. */
  department: string | null;
  /** Sheet "Organization" — the operating administration, e.g. 'FMCSA', 'FAA'. */
  sub_agency: string | null;
  title: string;
  /** Sheet "Link to details"; trim() on import — two cells have trailing spaces. */
  detail_url: string | null;
  estimated_solicitation_date: string | null;
  /** text[] — bind RAW. Must NOT go in the JSONB map in src/lib/db/query.ts. */
  set_asides: string[];
  notes: string | null;
  /** Set once the forecast turns into a real solicitation we entered. */
  promoted_opportunity_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface OpportunityVersion {
  id: string;
  opportunity_id: string;
  version_no: number;
  snapshot_json: Record<string, unknown>;
  content_hash: string;
  change_summary: string | null;
  captured_at: string;
}

export interface Attachment {
  id: string;
  opportunity_id: string;
  filename: string;
  source_url: string | null;
  storage_url: string | null;
  file_type: string | null;
  content_type: string | null;
  byte_size: number | null;
  parsed_text: string | null;
  parse_status: string;
  fetch_error: string | null;
  downloaded_at: string | null;
  created_at: string;
}

export interface ResponseDraft {
  id: string;
  opportunity_id: string;
  mode: ResponseMode;
  version_no: number;
  title: string | null;
  content: string;
  model_used: string | null;
  prompt_used: string | null;
  status: ResponseStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ResponseRevision {
  id: string;
  response_id: string;
  revision_no: number;
  instruction: string;
  previous_content: string | null;
  revised_content: string | null;
  model_used: string | null;
  revised_by: string | null;
  revised_at: string;
}

export interface StatusLogEntry {
  id: string;
  opportunity_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  changed_by: string;
  reason: string | null;
  changed_at: string;
}

export interface CompanyKnowledge {
  id: string;
  title: string;
  file_url: string | null;
  parsed_text: string | null;
  outcome: KnowledgeOutcome;
  category: string | null;
  tags: string[];
  embedded: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CrawlRun {
  id: string;
  source_id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  items_found: number;
  new_count: number;
  changed_count: number;
  closed_count: number;
  error_count: number;
  duration_ms: number | null;
  log: string | null;
  trigger: string;
}

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  opportunity_id: string | null;
  source_id: string | null;
  user_id: string | null;
  is_read: boolean;
  severity: "info" | "warning" | "critical";
  created_at: string;
}

// ── Connector contract ───────────────────────────────────────────────────────
/**
 * The single, predictable shape every connector returns. Everything downstream
 * (dedupe → DB → AI → UI) is shared and never changes when a new portal is added.
 */
export interface NormalizedOpportunity {
  /** Stable per-portal identifier (solicitation / bid number). */
  externalId: string;
  title: string;
  agency?: string | null;
  category?: string | null;
  naicsCode?: string | null;
  description?: string | null;
  postedDate?: string | null; // ISO date
  dueDate?: string | null; // ISO datetime
  qAndADeadline?: string | null;
  estimatedValue?: number | null;
  detailUrl?: string | null;
  statusOnSite?: string | null;
  attachmentUrls?: { filename: string; url: string }[];
  /** Optional raw payload kept for version snapshots / debugging. */
  raw?: Record<string, unknown>;
}

export interface ConnectorResult {
  opportunities: NormalizedOpportunity[];
  /** Soft warnings (e.g. "pagination capped") that should be logged, not fatal. */
  warnings: string[];
  /** Method actually used, for the crawl log. */
  methodUsed: string;
}

export interface Connector {
  key: string;
  label: string;
  /** The single predictable interface from the blueprint (§2). */
  fetchOpenOpportunities(opts?: ConnectorRunOptions): Promise<ConnectorResult>;
}

export interface ConnectorRunOptions {
  /** Cap pages/items for a fast smoke run. */
  limit?: number;
  signal?: AbortSignal;
}

// ── App settings shapes ──────────────────────────────────────────────────────
export interface AISettings {
  provider: string;
  generation_model: string;
  draft_model: string;
  summary_model: string;
  embedding_mode: "local" | "provider";
  embedding_model: string;
  temperature: number;
  auto_draft: boolean;
}

export interface RelevanceSettings {
  keywords: string[];
  naics: string[];
  min_value: number;
  auto_draft_threshold: number;
}

export interface NotificationSettings {
  deadline_reminder_days: number[];
  qa_reminder_days: number[];
  email_enabled: boolean;
  slack_enabled: boolean;
}

export interface CompanySettings {
  name: string;
  tagline: string;
  about: string;
  industry?: string;
  capabilities?: string[];
}
