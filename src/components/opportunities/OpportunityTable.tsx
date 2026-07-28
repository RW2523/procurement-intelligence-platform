import Link from "next/link";
import { Paperclip, FileText, Award , AlertCircle } from "lucide-react";
import { countMissing } from "@/lib/bids/completeness";
import type { OpportunityView } from "@/lib/types";
import { OPP_STATUS_STYLES, BID_REC_STYLES, BUCKET_STYLES, URGENCY_STYLES, pipelineStyle } from "@/lib/status";
import { Badge } from "@/components/ui";
import { fmtDate, deadlineLabel, daysUntil } from "@/lib/utils";

export function OpportunityTable({ opps, dense = false }: { opps: OpportunityView[]; dense?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[0.85rem] border-collapse">
        <thead>
          <tr className="text-left text-[0.7rem] uppercase tracking-wide text-[var(--color-faint)] border-b border-[var(--color-border)]">
            <th className="py-2.5 px-4 font-semibold">Opportunity</th>
            {!dense && <th className="py-2.5 px-3 font-semibold">Department</th>}
            {!dense && <th className="py-2.5 px-3 font-semibold">Source</th>}
            <th className="py-2.5 px-3 font-semibold">Stage</th>
            <th className="py-2.5 px-3 font-semibold">Status</th>
            <th className="py-2.5 px-3 font-semibold">Score</th>
            <th className="py-2.5 px-3 font-semibold">Urgency</th>
            <th className="py-2.5 px-3 font-semibold">AI bid</th>
            <th className="py-2.5 px-3 font-semibold">Due</th>
          </tr>
        </thead>
        <tbody>
          {opps.map((o) => {
            const s = OPP_STATUS_STYLES[o.status];
            // pipelineStyle(), not PIPELINE_STYLES[…] — rows that predate the
            // 2026 vocabulary migration would make the direct lookup undefined
            // and crash the whole list on `.label`.
            const stg = pipelineStyle(o.pipeline_stage);
            const bucket = o.pursuit_bucket ? BUCKET_STYLES[o.pursuit_bucket] : null;
            const urgency = o.urgency ? URGENCY_STYLES[o.urgency] : null;
            const d = daysUntil(o.due_date);
            const closing = d !== null && d >= 0 && d <= 7;
            return (
              <tr key={o.id} className="border-b border-[var(--color-border)] hover:bg-[var(--color-surface-2)] transition-colors">
                <td className="py-3 px-4 max-w-[400px]">
                  <Link
                    href={`/opportunities/${o.id}`}
                    className="font-medium text-[var(--color-ink)] hover:text-[var(--color-brand-600)] line-clamp-1"
                  >
                    {o.title}
                  </Link>
                  <div className="text-[0.72rem] text-[var(--color-faint)] mt-0.5 flex items-center gap-2 flex-wrap">
                    <span className="font-mono">{o.external_id}</span>
                    {o.agency && <span className="line-clamp-1">· {o.agency}</span>}
                    {o.set_asides?.length > 0 && (
                      <span className="inline-flex items-center gap-0.5 text-[var(--color-mint-700)] font-medium">
                        <Award size={11} /> {o.set_asides[0].replace(" Set-Aside", "")}
                      </span>
                    )}
                    {!!o.attachment_count && (
                      <span className="inline-flex items-center gap-0.5">
                        <Paperclip size={11} /> {o.attachment_count}
                      </span>
                    )}
                    {!!o.response_count && (
                      <span className="inline-flex items-center gap-0.5 text-[var(--color-violet-500)]">
                        <FileText size={11} /> {o.response_count}
                      </span>
                    )}
                    {(() => {
                      // Same definition the detail page uses, so "2 needed" here
                      // and "2 details missing" there can never disagree.
                      const { blocking, total } =
                        countMissing(o as unknown as Record<string, unknown>);
                      // BLOCKING ONLY. Measured against the operator's real
                      // workbook, 71 of 71 rows are missing at least one
                      // "helpful" field (estimated value is blank on 70, period
                      // of performance on 69) simply because the sheet does not
                      // track them. A badge that appears on every row carries no
                      // information — this one has to mean "look at me".
                      if (!blocking) return null;
                      return (
                        <span
                          className="inline-flex items-center gap-0.5"
                          style={{ color: blocking
                            ? "var(--color-amber-600,#a16207)"
                            : "var(--color-faint)" }}
                          title={`${blocking} detail${blocking === 1 ? "" : "s"} needed before this can be worked properly` +
                                 (total > blocking ? ` (${total - blocking} more optional)` : "")}
                        >
                          <AlertCircle size={11} /> {blocking}
                        </span>
                      );
                    })()}
                  </div>
                </td>
                {!dense && (
                  <td className="py-3 px-3 whitespace-nowrap">
                    {o.department ? (
                      <>
                        <div className="text-[var(--color-ink-2)] font-medium">{o.department}</div>
                        {o.sub_agency && (
                          <div className="text-[0.7rem] text-[var(--color-faint)]">{o.sub_agency}</div>
                        )}
                      </>
                    ) : (
                      <span className="text-[0.72rem] text-[var(--color-faint)]">—</span>
                    )}
                  </td>
                )}
                {!dense && (
                  <td className="py-3 px-3">
                    <span className="chip">{o.source?.state ?? o.state ?? o.source?.name ?? "—"}</span>
                  </td>
                )}
                <td className="py-3 px-3">
                  <Badge label={stg.label} bg={stg.bg} fg={stg.fg} dot={stg.dot} />
                </td>
                <td className="py-3 px-3">
                  <Badge label={s.label} bg={s.bg} fg={s.fg} dot={s.dot} />
                </td>
                <td className="py-3 px-3 whitespace-nowrap">
                  {bucket ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="font-semibold text-[var(--color-ink)] tabular-nums w-7 text-right">
                        {o.pursuit_score}
                      </span>
                      <Badge label={bucket.label} bg={bucket.bg} fg={bucket.fg} dot={bucket.dot} />
                    </span>
                  ) : (
                    <span className="text-[0.72rem] text-[var(--color-faint)]">Unscored</span>
                  )}
                </td>
                <td className="py-3 px-3">
                  {urgency ? (
                    <Badge label={urgency.label} bg={urgency.bg} fg={urgency.fg} dot={urgency.dot} />
                  ) : (
                    <span className="text-[0.72rem] text-[var(--color-faint)]">—</span>
                  )}
                </td>
                <td className="py-3 px-3">
                  {o.bid_recommendation ? (
                    <Badge
                      label={BID_REC_STYLES[o.bid_recommendation].label}
                      bg={BID_REC_STYLES[o.bid_recommendation].bg}
                      fg={BID_REC_STYLES[o.bid_recommendation].fg}
                      dot={BID_REC_STYLES[o.bid_recommendation].dot}
                    />
                  ) : (
                    <span className="text-[0.72rem] text-[var(--color-faint)]">—</span>
                  )}
                </td>
                <td className="py-3 px-3 whitespace-nowrap">
                  <div className="text-[var(--color-ink-2)]">{fmtDate(o.due_date)}</div>
                  <div className={`text-[0.7rem] ${closing ? "text-[var(--color-rose-700)] font-medium" : "text-[var(--color-faint)]"}`}>
                    {deadlineLabel(o.due_date)}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
