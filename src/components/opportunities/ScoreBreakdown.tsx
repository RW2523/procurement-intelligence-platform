import { Target } from "lucide-react";
import type { OpportunityView } from "@/lib/types";
import { BUCKET_STYLES, URGENCY_STYLES } from "@/lib/status";
import { Badge, Card, CardHeader } from "@/components/ui";

/**
 * "Why this score" — the targeting engine's full evidence trail: every criterion
 * that fired, its points, and the exact phrases matched (plus exclusion overrides
 * and the DoD IT-only note when applicable).
 */
export function ScoreBreakdown({ opp }: { opp: OpportunityView }) {
  if (opp.pursuit_bucket == null || opp.pursuit_score == null) return null;
  const bucket = BUCKET_STYLES[opp.pursuit_bucket];
  const urgency = opp.urgency ? URGENCY_STYLES[opp.urgency] : null;
  const rows = opp.score_breakdown ?? [];

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Target size={16} /> Why this score
          </span>
        }
        subtitle="Weighted targeting engine — five-dimension profile match"
        action={
          <span className="flex items-center gap-2">
            <span className="text-[1.05rem] font-bold text-[var(--color-ink)] tabular-nums">{opp.pursuit_score}</span>
            <Badge label={bucket.label} bg={bucket.bg} fg={bucket.fg} dot={bucket.dot} />
            {urgency && <Badge label={urgency.label} bg={urgency.bg} fg={urgency.fg} dot={urgency.dot} />}
          </span>
        }
      />
      <div className="px-5 py-3">
        {opp.excluded_reason && (
          <div className="mb-3 text-[0.82rem] text-[var(--color-rose-700)] bg-[var(--color-rose-100)] rounded-lg px-3 py-2">
            Excluded by keyword: <strong>{opp.excluded_reason}</strong> — no technical capability matched.
          </div>
        )}
        {rows.length ? (
          <ul className="divide-y divide-[var(--color-border)]">
            {rows.map((b, i) => (
              <li key={i} className="py-2 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[0.85rem] font-medium text-[var(--color-ink)]">{b.criterion}</div>
                  <div className="text-[0.75rem] text-[var(--color-muted)] mt-0.5">
                    {b.matched.slice(0, 6).join(" · ")}
                    {b.note && <span className="text-[var(--color-amber-700)]"> — {b.note}</span>}
                  </div>
                </div>
                <span
                  className={`shrink-0 font-semibold tabular-nums text-[0.9rem] ${
                    b.points > 0 ? "text-[var(--color-mint-700)]" : b.points < 0 ? "text-[var(--color-rose-700)]" : "text-[var(--color-faint)]"
                  }`}
                >
                  {b.points > 0 ? `+${b.points}` : b.points}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[0.83rem] text-[var(--color-muted)] py-2">
            No targeting criteria matched — scored {opp.pursuit_score} and bucketed “{bucket.label}”.
          </p>
        )}
        <div className="mt-2 pt-2 border-t border-[var(--color-border)] flex flex-wrap gap-2 text-[0.72rem] text-[var(--color-faint)]">
          {opp.solicitation_type && <span className="chip">Type: {opp.solicitation_type}</span>}
          {opp.contract_vehicle && <span className="chip">Vehicle: {opp.contract_vehicle}</span>}
          {opp.set_asides?.map((s) => (
            <span key={s} className="chip">{s}</span>
          ))}
          {opp.agency_priority && <span className="chip">Priority agency</span>}
        </div>
      </div>
    </Card>
  );
}
