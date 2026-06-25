/**
 * Domain types — the shared contract for DB rows, connector output, and view models.
 * Kept hand-written (rather than generated) so the whole codebase reads against
 * one stable vocabulary.
 */

// ── Enums (mirror the Postgres enums) ────────────────────────────────────────
export type UserRole = "admin" | "writer" | "approver" | "viewer";

export type OppStatus =
  | "NEW"
  | "OPEN"
  | "AMENDED"
  | "CLOSING_SOON"
  | "CLOSED"
  | "REMOVED"
  | "AWARDED"
  | "CANCELLED";

export type PipelineStage =
  | "BACKLOG"
  | "REVIEWING"
  | "DRAFTING"
  | "APPROVED"
  | "SUBMITTED"
  | "WON"
  | "LOST"
  | "DECLINED";

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

export const PIPELINE_STAGES: PipelineStage[] = [
  "BACKLOG",
  "REVIEWING",
  "DRAFTING",
  "APPROVED",
  "SUBMITTED",
  "WON",
  "LOST",
  "DECLINED",
];

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
  byte_size: number | null;
  parsed_text: string | null;
  parse_status: string;
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
}
