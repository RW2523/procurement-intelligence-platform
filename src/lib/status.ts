import type {
  OppStatus,
  PipelineStage,
  ResponseStatus,
  SourceStatus,
  NotificationType,
  BidRecommendation,
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

export const PIPELINE_STYLES: Record<PipelineStage, Style> = {
  BACKLOG: { label: "Backlog", bg: "#eef0f4", fg: "#5b6170", dot: "#9aa1ad" },
  REVIEWING: { label: "Reviewing", bg: "var(--color-sky-100)", fg: "var(--color-sky-700)", dot: "var(--color-sky-500)" },
  DRAFTING: { label: "Drafting", bg: "var(--color-violet-100)", fg: "#6d28d9", dot: "var(--color-violet-500)" },
  APPROVED: { label: "Approved", bg: "var(--color-brand-50)", fg: "var(--color-brand-700)", dot: "var(--color-brand-500)" },
  SUBMITTED: { label: "Submitted", bg: "var(--color-amber-100)", fg: "var(--color-amber-700)", dot: "var(--color-amber-500)" },
  WON: { label: "Won", bg: "var(--color-mint-100)", fg: "var(--color-mint-700)", dot: "var(--color-mint-500)" },
  LOST: { label: "Lost", bg: "var(--color-rose-100)", fg: "var(--color-rose-700)", dot: "var(--color-rose-500)" },
  DECLINED: { label: "Declined", bg: "#eef0f4", fg: "#5b6170", dot: "#9aa1ad" },
};

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

export function relevanceStyle(score: number | null | undefined): Style {
  if (score == null) return { label: "Unscored", bg: "#eef0f4", fg: "#5b6170" };
  if (score >= 70) return { label: `${Math.round(score)} · Strong fit`, bg: "var(--color-mint-100)", fg: "var(--color-mint-700)" };
  if (score >= 40) return { label: `${Math.round(score)} · Possible`, bg: "var(--color-amber-100)", fg: "var(--color-amber-700)" };
  return { label: `${Math.round(score)} · Low fit`, bg: "#eef0f4", fg: "#5b6170" };
}
