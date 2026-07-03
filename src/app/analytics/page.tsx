import { Trophy, DollarSign, Gauge, Activity, Target } from "lucide-react";
import { dbConfigured } from "@/lib/supabase/server";
import { getAnalytics } from "@/lib/db/analytics";
import { getDashboardStats } from "@/lib/db/dashboard";
import { Card, CardHeader, PageHeader, Stat } from "@/components/ui";
import { StageChart, ModeChart, StateChart } from "@/components/analytics/AnalyticsCharts";
import { SetupNotice } from "@/components/SetupNotice";
import { fmtCurrency, pct } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  if (!dbConfigured) {
    return (
      <>
        <PageHeader title="Analytics" subtitle="Is the system paying off?" />
        <SetupNotice />
      </>
    );
  }
  const [a, stats] = await Promise.all([getAnalytics(), getDashboardStats()]);

  return (
    <>
      <PageHeader title="Analytics" subtitle="Pipeline, win/loss, AI mode usage, and crawl health" />

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
        <Stat label="Pipeline value" value={fmtCurrency(stats.pipelineValue)} icon={<DollarSign size={15} />} hint="Open est. value" />
        <Stat label="Win rate" value={a.winRate == null ? "—" : `${a.winRate}%`} icon={<Trophy size={15} />} accent="var(--color-mint-100)" hint={`${a.won}W · ${a.lost}L`} />
        <Stat label="Submitted" value={a.submitted} icon={<Activity size={15} />} accent="var(--color-amber-100)" hint="Responses sent" />
        <Stat label="Avg relevance" value={a.avgRelevance == null ? "—" : pct(a.avgRelevance)} icon={<Target size={15} />} accent="var(--color-brand-50)" hint="Across all opps" />
        <Stat label="Crawl success" value={a.crawlSuccessRate == null ? "—" : `${a.crawlSuccessRate}%`} icon={<Gauge size={15} />} accent="var(--color-violet-100)" hint={`${a.totalCrawls} runs`} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Card>
          <CardHeader title="Pipeline by stage" subtitle="Where opportunities sit in the lifecycle" />
          <div className="p-4"><StageChart data={a.byStage} /></div>
        </Card>
        <Card>
          <CardHeader title="AI mode usage" subtitle="Style-matched vs LLM-original drafts" />
          <div className="p-4"><ModeChart data={a.modeUsage} /></div>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Coverage by state" subtitle="Total vs currently-open opportunities per portal" />
          <div className="p-4"><StateChart data={a.byState} /></div>
        </Card>

        {/* ── Targeting engine (plan §6.6) ─────────────────────────────────── */}
        <Card>
          <CardHeader title="Targeting score distribution" subtitle="Weighted engine points across all scored opportunities" />
          <div className="px-5 py-4 space-y-2.5">
            {a.scoreHistogram.map((h) => {
              const max = Math.max(...a.scoreHistogram.map((x) => x.count), 1);
              const strong = h.label === "80+" || h.label === "60–79";
              return (
                <div key={h.label} className="flex items-center gap-3">
                  <span className="w-14 text-[0.78rem] tabular-nums text-[var(--color-ink-2)]">{h.label}</span>
                  <div className="flex-1 h-2.5 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.max((h.count / max) * 100, h.count ? 1.5 : 0)}%`,
                        background: strong ? "var(--color-mint-500)" : "var(--color-brand-400)",
                      }}
                    />
                  </div>
                  <span className="w-12 text-right text-[0.78rem] tabular-nums text-[var(--color-muted)]">{h.count}</span>
                </div>
              );
            })}
          </div>
        </Card>

        <Card>
          <CardHeader title="Noise removed by exclusions" subtitle="§8 exclude-keyword hits by group (LLM cost avoided)" />
          <div className="px-5 py-4 space-y-2.5">
            {a.exclusionByGroup.length === 0 && (
              <div className="text-[0.82rem] text-[var(--color-muted)]">No exclusions recorded yet.</div>
            )}
            {a.exclusionByGroup.map((e) => {
              const max = Math.max(...a.exclusionByGroup.map((x) => x.count), 1);
              return (
                <div key={e.group} className="flex items-center gap-3">
                  <span className="w-24 text-[0.78rem] text-[var(--color-ink-2)]">{e.group}</span>
                  <div className="flex-1 h-2.5 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
                    <div className="h-full rounded-full bg-[var(--color-rose-500)]" style={{ width: `${(e.count / max) * 100}%` }} />
                  </div>
                  <span className="w-12 text-right text-[0.78rem] tabular-nums text-[var(--color-muted)]">{e.count}</span>
                </div>
              );
            })}
          </div>
        </Card>

        <Card>
          <CardHeader title="Buckets by source" subtitle="Where the actionable opportunities come from" />
          <div className="px-5 py-3 overflow-x-auto">
            <table className="w-full text-[0.82rem]">
              <thead>
                <tr className="text-left text-[0.7rem] uppercase tracking-wide text-[var(--color-faint)] border-b border-[var(--color-border)]">
                  <th className="py-2 font-semibold">Source</th>
                  <th className="py-2 font-semibold text-right">Pursue</th>
                  <th className="py-2 font-semibold text-right">Capture</th>
                  <th className="py-2 font-semibold text-right">Manual</th>
                  <th className="py-2 font-semibold text-right">Ignored</th>
                </tr>
              </thead>
              <tbody>
                {a.bucketBySource.map((r) => (
                  <tr key={r.source} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="py-2 font-medium text-[var(--color-ink)]">{r.source}</td>
                    <td className="py-2 text-right tabular-nums text-[var(--color-mint-700)] font-semibold">{r.PURSUE}</td>
                    <td className="py-2 text-right tabular-nums text-[var(--color-brand-700)]">{r.CAPTURE_REVIEW}</td>
                    <td className="py-2 text-right tabular-nums text-[var(--color-amber-700)]">{r.MANUAL_REVIEW}</td>
                    <td className="py-2 text-right tabular-nums text-[var(--color-faint)]">{r.IGNORE}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <CardHeader title="Outcomes by bucket" subtitle="Does the score predict wins? (fills in as bids close)" />
          <div className="px-5 py-3">
            {a.winByBucket.length === 0 ? (
              <div className="text-[0.82rem] text-[var(--color-muted)] py-2">
                No submitted / won / lost opportunities yet — this fills in as the team moves bids
                through the board, and shows whether high-scoring buckets convert better.
              </div>
            ) : (
              <table className="w-full text-[0.82rem]">
                <thead>
                  <tr className="text-left text-[0.7rem] uppercase tracking-wide text-[var(--color-faint)] border-b border-[var(--color-border)]">
                    <th className="py-2 font-semibold">Bucket</th>
                    <th className="py-2 font-semibold text-right">Submitted</th>
                    <th className="py-2 font-semibold text-right">Won</th>
                    <th className="py-2 font-semibold text-right">Lost</th>
                    <th className="py-2 font-semibold text-right">Win rate</th>
                  </tr>
                </thead>
                <tbody>
                  {a.winByBucket.map((r) => {
                    const decided = r.won + r.lost;
                    return (
                      <tr key={r.bucket} className="border-b border-[var(--color-border)] last:border-0">
                        <td className="py-2 font-medium text-[var(--color-ink)]">{r.bucket.replace("_", " ")}</td>
                        <td className="py-2 text-right tabular-nums">{r.submitted}</td>
                        <td className="py-2 text-right tabular-nums text-[var(--color-mint-700)]">{r.won}</td>
                        <td className="py-2 text-right tabular-nums text-[var(--color-rose-700)]">{r.lost}</td>
                        <td className="py-2 text-right tabular-nums font-semibold">
                          {decided ? `${Math.round((r.won / decided) * 100)}%` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
