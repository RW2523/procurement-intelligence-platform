import type {
  OppStatus,
  PipelineStage,
  ResponseStatus,
  SourceStatus,
  NotificationType,
  BidRecommendation,
  PursuitBucket,
  UrgencyBand,
} from "@/lib/types";

interface Style {
  label: string;
  /** inline style for badge bg/text — avoids Tailwind dynamic-class purging issues */
  bg: string;
  fg: string;
  dot?: string;
}

export const OPP_STATUS_STYLES: Record<OppStatus, Style> = {
  NEW: { label: "New", bg: "var(--color-brand-50)", fg: "var(--color-brand-700)", dot: "var(--color-brand-500)" },
  OPEN: { label: "Open", bg: "var(--color-sky-100)", fg: "var(--color-sky-700)", dot: "var(--color-sky-500)" },
  AMENDED: { label: "Amended", bg: "var(--color-amber-100)", fg: "var(--color-amber-700)", dot: "var(--color-amber-500)" },
  CLOSING_SOON: { label: "Closing soon", bg: "var(--color-rose-100)", fg: "var(--color-rose-700)", dot: "var(--color-rose-500)" },
  CLOSED: { label: "Closed", bg: "#eef0f4", fg: "#5b6170", dot: "#9aa1ad" },
  REMOVED: { label: "Removed", bg: "#f3edff", fg: "#6d28d9", dot: "var(--color-violet-500)" },
  AWARDED: { label: "Awarded", bg: "var(--color-mint-100)", fg: "var(--color-mint-700)", dot: "var(--color-mint-500)" },
  CANCELLED: { label: "Cancelled", bg: "#eef0f4", fg: "#5b6170", dot: "#9aa1ad" },
};

/**
 * The 11 capture & proposal phases. `Record<PipelineStage, Style>` makes this
 * the compile-time exhaustiveness net for the vocabulary: `npm run typecheck`
 * fails if a stage has no style, and every lookup in the app is unguarded
 * (`PIPELINE_STYLES[opp.pipeline_stage].label`), so a missing entry would be a
 * runtime TypeError on the board and the detail page.
 *
 * Colour story — the 11 stages need 11 distinguishable dots, which is more hues
 * than the token palette carries, so five literals join the six tokens:
 *   grey → sky → indigo (early, warming up) · warm grey for the NO_BID exit
 *   violet → teal → amber → orange → fuchsia (in flight, escalating)
 *   mint / rose for the two terminal outcomes.
 * NO_BID gets a muted rose-grey, not the plain grey of IDENTIFIED: it is a
 * deliberate decision, not an untouched row, and must not read as "new".
 */
export const PIPELINE_STYLES: Record<PipelineStage, Style> = {
  IDENTIFIED: { label: "Identified", bg: "#eef0f4", fg: "#5b6170", dot: "#9aa1ad" },
  QUALIFYING: { label: "Qualifying", bg: "var(--color-sky-100)", fg: "var(--color-sky-700)", dot: "var(--color-sky-500)" },
  PURSUING: { label: "Pursuing", bg: "var(--color-brand-50)", fg: "var(--color-brand-700)", dot: "var(--color-brand-500)" },
  NO_BID: { label: "No Bid", bg: "#f4eef0", fg: "#7d5b64", dot: "#b08794" },
  REVIEWING: { label: "Reviewing", bg: "var(--color-violet-100)", fg: "#6d28d9", dot: "var(--color-violet-500)" },
  APPROVED: { label: "Approved", bg: "#ccfbf1", fg: "#0f766e", dot: "#14b8a6" },
  SUBMITTED: { label: "Submitted", bg: "var(--color-amber-100)", fg: "var(--color-amber-700)", dot: "var(--color-amber-500)" },
  ORALS: { label: "Orals", bg: "#ffedd5", fg: "#c2410c", dot: "#f97316" },
  BAFO: { label: "BAFO", bg: "#fae8ff", fg: "#a21caf", dot: "#d946ef" },
  WON: { label: "Won", bg: "var(--color-mint-100)", fg: "var(--color-mint-700)", dot: "var(--color-mint-500)" },
  LOST: { label: "Lost", bg: "var(--color-rose-100)", fg: "var(--color-rose-700)", dot: "var(--color-rose-500)" },
};

/**
 * Retired stage values → their replacement. Rows migrated by
 * deploy/db/migrations/001-pipeline-2026.sql, but `opportunity_status_log`
 * keeps the historical strings in old_value/new_value forever, so the audit
 * trail needs this to render them. Also a safety net for any row that somehow
 * predates the migration, via `pipelineLabel()` below.
 */
const RETIRED_STAGES: Record<string, PipelineStage> = {
  BACKLOG: "IDENTIFIED",
  DRAFTING: "PURSUING",
  DECLINED: "NO_BID",
};

/**
 * Human label for ANY stage string, including retired ones and unknown values.
 * Prefer this over a bare `PIPELINE_STYLES[x].label` wherever the input is a
 * free-text column (notably opportunity_status_log.old_value/new_value), which
 * is not constrained to the current vocabulary.
 */
export function pipelineLabel(stage: string | null | undefined): string {
  if (!stage) return "—";
  const mapped = RETIRED_STAGES[stage] ?? stage;
  return PIPELINE_STYLES[mapped as PipelineStage]?.label ?? stage;
}

/** Style for ANY stage string, falling back to neutral rather than throwing. */
export function pipelineStyle(stage: string | null | undefined): Style {
  const mapped = stage ? (RETIRED_STAGES[stage] ?? stage) : "";
  return (
    PIPELINE_STYLES[mapped as PipelineStage] ?? {
      label: stage || "Unknown",
      bg: "#eef0f4",
      fg: "#5b6170",
      dot: "#9aa1ad",
    }
  );
}

export const RESPONSE_STATUS_STYLES: Record<ResponseStatus, Style> = {
  DRAFT: { label: "Draft", bg: "#eef0f4", fg: "#5b6170" },
  IN_REVIEW: { label: "In review", bg: "var(--color-sky-100)", fg: "var(--color-sky-700)" },
  APPROVED: { label: "Approved", bg: "var(--color-mint-100)", fg: "var(--color-mint-700)" },
  SUBMITTED: { label: "Submitted", bg: "var(--color-brand-50)", fg: "var(--color-brand-700)" },
  REJECTED: { label: "Rejected", bg: "var(--color-rose-100)", fg: "var(--color-rose-700)" },
};

export const SOURCE_STATUS_STYLES: Record<SourceStatus, Style> = {
  active: { label: "Active", bg: "var(--color-mint-100)", fg: "var(--color-mint-700)", dot: "var(--color-mint-500)" },
  paused: { label: "Paused", bg: "#eef0f4", fg: "#5b6170", dot: "#9aa1ad" },
  error: { label: "Error", bg: "var(--color-rose-100)", fg: "var(--color-rose-700)", dot: "var(--color-rose-500)" },
  needs_connector: { label: "Needs connector", bg: "var(--color-amber-100)", fg: "var(--color-amber-700)", dot: "var(--color-amber-500)" },
};

export const NOTIF_STYLES: Record<NotificationType, { label: string; emoji: string }> = {
  NEW_OPPORTUNITY: { label: "New opportunity", emoji: "✨" },
  AMENDMENT: { label: "Amendment", emoji: "📝" },
  DEADLINE: { label: "Deadline", emoji: "⏰" },
  QA_DEADLINE: { label: "Q&A deadline", emoji: "❓" },
  CRAWL_FAILURE: { label: "Crawl failure", emoji: "🚨" },
  RESPONSE_APPROVED: { label: "Response approved", emoji: "✅" },
  STATUS_CHANGE: { label: "Status change", emoji: "🔄" },
};

export const BID_REC_STYLES: Record<BidRecommendation, Style> = {
  BID: { label: "Bid", bg: "var(--color-mint-100)", fg: "var(--color-mint-700)", dot: "var(--color-mint-500)" },
  REVIEW: { label: "Review", bg: "var(--color-amber-100)", fg: "var(--color-amber-700)", dot: "var(--color-amber-500)" },
  NO_BID: { label: "No-bid", bg: "#eef0f4", fg: "#5b6170", dot: "#9aa1ad" },
};

/** §9 buckets: 80+ pursue immediately · 60–79 capture review · 40–59 manual review · <40 ignore. */
export const BUCKET_STYLES: Record<PursuitBucket, Style> = {
  PURSUE: { label: "Pursue", bg: "var(--color-mint-100)", fg: "var(--color-mint-700)", dot: "var(--color-mint-500)" },
  CAPTURE_REVIEW: { label: "Capture review", bg: "var(--color-brand-50)", fg: "var(--color-brand-700)", dot: "var(--color-brand-500)" },
  MANUAL_REVIEW: { label: "Manual review", bg: "var(--color-amber-100)", fg: "var(--color-amber-700)", dot: "var(--color-amber-500)" },
  IGNORE: { label: "Ignored", bg: "#eef0f4", fg: "#5b6170", dot: "#9aa1ad" },
};

/** §10 urgency: 10–20d urgent · 21–45d standard · 46+d early capture · <10d insufficient. */
export const URGENCY_STYLES: Record<UrgencyBand, Style> = {
  URGENT: { label: "Urgent", bg: "var(--color-rose-100)", fg: "var(--color-rose-700)", dot: "var(--color-rose-500)" },
  STANDARD: { label: "Standard", bg: "var(--color-sky-100)", fg: "var(--color-sky-700)", dot: "var(--color-sky-500)" },
  EARLY_CAPTURE: { label: "Early capture", bg: "var(--color-mint-100)", fg: "var(--color-mint-700)", dot: "var(--color-mint-500)" },
  INSUFFICIENT_TIME: { label: "< 10 days", bg: "#eef0f4", fg: "#5b6170", dot: "#9aa1ad" },
  NO_DATE: { label: "No date", bg: "#eef0f4", fg: "#5b6170" },
};

export function relevanceStyle(score: number | null | undefined): Style {
  if (score == null) return { label: "Unscored", bg: "#eef0f4", fg: "#5b6170" };
  if (score >= 70) return { label: `${Math.round(score)} · Strong fit`, bg: "var(--color-mint-100)", fg: "var(--color-mint-700)" };
  if (score >= 40) return { label: `${Math.round(score)} · Possible`, bg: "var(--color-amber-100)", fg: "var(--color-amber-700)" };
  return { label: `${Math.round(score)} · Low fit`, bg: "#eef0f4", fg: "#5b6170" };
}
