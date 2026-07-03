import Link from "next/link";
import { Inbox, Sparkles, Clock, Target, FileText, Radar, ArrowRight } from "lucide-react";
import { dbConfigured } from "@/lib/supabase/server";
import { getDashboardStats } from "@/lib/db/dashboard";
import { listOpportunities } from "@/lib/db/opportunities";
import { listSourceHealth } from "@/lib/db/sources";
import { Card, CardHeader, Stat, PageHeader, EmptyState, Badge } from "@/components/ui";
import { OpportunityTable } from "@/components/opportunities/OpportunityTable";
import { RunCrawlButton } from "@/components/RunCrawlButton";
import { SetupNotice } from "@/components/SetupNotice";
import { SOURCE_STATUS_STYLES } from "@/lib/status";
import { fmtDateTime, daysUntil } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  if (!dbConfigured) {
    return (
      <>
        <PageHeader title="Dashboard" subtitle="Procurement intelligence at a glance" />
        <SetupNotice />
      </>
    );
  }

  const [stats, recentNew, openByDue, sources] = await Promise.all([
    getDashboardStats(),
    listOpportunities({ status: "NEW", sort: "newest", limit: 8 }),
    listOpportunities({ sort: "due_date", limit: 250 }),
    listSourceHealth(),
  ]);

  const closingSoon = openByDue
    .filter((o) => ["NEW", "OPEN", "AMENDED", "CLOSING_SOON"].includes(o.status))
    .filter((o) => {
      const d = daysUntil(o.due_date);
      return d !== null && d >= 0 && d <= 7;
    })
    .slice(0, 8);

  const today = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(new Date());

  return (
    <>
      <PageHeader title="Dashboard" subtitle={today} actions={<RunCrawlButton label="Run all crawls" />} />

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
        <Stat label="Open opportunities" value={stats.totalOpen} icon={<Inbox size={15} />} hint={`${stats.totalOpps} tracked total`} />
        <Stat
          label="Pursue now"
          value={stats.pursueNow}
          icon={<Sparkles size={15} />}
          accent="var(--color-mint-100)"
          hint={`${stats.newPursue} new since yesterday · ${stats.captureReview} capture review`}
        />
        <Stat label="Closing ≤ 7 days" value={stats.closingSoon} icon={<Clock size={15} />} accent="var(--color-rose-100)" hint="Submission deadlines" />
        <Stat label="Amended" value={stats.amended} icon={<Target size={15} />} accent="var(--color-amber-100)" hint="May need re-review" />
        <Stat label="Drafts generated" value={stats.totalResponses} icon={<FileText size={15} />} accent="var(--color-violet-100)" hint={`${stats.submitted} submitted`} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 space-y-5">
          <Card>
            <CardHeader
              title="New since last crawl"
              subtitle="Fresh opportunities awaiting bid / no-bid review"
              action={<Link href="/opportunities?status=NEW" className="text-[0.8rem] text-[var(--color-brand-600)] hover:underline flex items-center gap-1">View all <ArrowRight size={13} /></Link>}
            />
            {recentNew.length ? (
              <OpportunityTable opps={recentNew} />
            ) : (
              <EmptyState title="No new opportunities" description="Run a crawl to discover the latest postings." action={<RunCrawlButton label="Run all crawls" variant="soft" />} />
            )}
          </Card>

          <Card>
            <CardHeader
              title="Closing soon"
              subtitle="Open opportunities due within 7 days"
              action={<Link href="/opportunities?sort=due_date" className="text-[0.8rem] text-[var(--color-brand-600)] hover:underline flex items-center gap-1">All deadlines <ArrowRight size={13} /></Link>}
            />
            {closingSoon.length ? (
              <OpportunityTable opps={closingSoon} />
            ) : (
              <EmptyState title="Nothing urgent" description="No open opportunities are due in the next 7 days." />
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Portal health" subtitle="Connector status & last run" />
            <div className="divide-y divide-[var(--color-border)]">
              {sources.map((s) => {
                const st = SOURCE_STATUS_STYLES[s.status];
                return (
                  <Link key={s.id} href="/sources" className="flex items-center justify-between px-5 py-3 hover:bg-[var(--color-surface-2)]">
                    <div>
                      <div className="text-[0.85rem] font-medium text-[var(--color-ink)]">{s.name}</div>
                      <div className="text-[0.72rem] text-[var(--color-faint)]">
                        {s.last_run ? `Last run ${fmtDateTime(s.last_run.started_at)}` : "Never run"} · {s.open_count} open
                      </div>
                    </div>
                    <Badge label={st.label} bg={st.bg} fg={st.fg} dot={st.dot} />
                  </Link>
                );
              })}
            </div>
          </Card>

          <Card>
            <CardHeader title="Urgency mix" subtitle="Open opportunities by §10 response window" />
            <div className="px-5 py-4 space-y-3">
              {stats.urgencyDist.map((u) => {
                const max = Math.max(...stats.urgencyDist.map((x) => x.count), 1);
                return (
                  <div key={u.band} className="flex items-center gap-3">
                    <span className="w-36 text-[0.76rem] text-[var(--color-ink-2)]">{u.label}</span>
                    <div className="flex-1 h-2 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${(u.count / max) * 100}%`, background: u.color }} />
                    </div>
                    <span className="text-[0.78rem] tabular-nums text-[var(--color-muted)] w-10 text-right">{u.count}</span>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card>
            <CardHeader title="By state" subtitle="Opportunities per portal" />
            <div className="px-5 py-4 space-y-3">
              {stats.byState.length === 0 && <div className="text-[0.82rem] text-[var(--color-muted)]">No data yet.</div>}
              {stats.byState.map((b) => {
                const max = Math.max(...stats.byState.map((x) => x.count), 1);
                return (
                  <div key={b.state} className="flex items-center gap-3">
                    <span className="w-8 text-[0.78rem] font-medium text-[var(--color-ink-2)]">{b.state}</span>
                    <div className="flex-1 h-2 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
                      <div className="h-full rounded-full bg-[var(--color-brand-400)]" style={{ width: `${(b.count / max) * 100}%` }} />
                    </div>
                    <span className="text-[0.78rem] tabular-nums text-[var(--color-muted)] w-8 text-right">{b.count}</span>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card className="p-5 flex items-center gap-3">
            <span className="grid place-items-center w-10 h-10 rounded-lg bg-[var(--color-brand-50)] text-[var(--color-brand-600)]">
              <Radar size={18} />
            </span>
            <div className="text-[0.82rem] text-[var(--color-muted)]">
              <span className="font-medium text-[var(--color-ink)]">{sources.length} portals</span> connected. Add more from{" "}
              <Link href="/sources/new" className="text-[var(--color-brand-600)] hover:underline">Sources → Add portal</Link>.
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
