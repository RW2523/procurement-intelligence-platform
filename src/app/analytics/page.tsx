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
      </div>
    </>
  );
}
