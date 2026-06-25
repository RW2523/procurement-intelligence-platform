import Link from "next/link";
import { Plus, ExternalLink, Clock, CheckCircle2, AlertTriangle, Activity } from "lucide-react";
import { dbConfigured } from "@/lib/supabase/server";
import { listSourceHealth, getAllCrawlRuns } from "@/lib/db/sources";
import { Card, CardHeader, PageHeader, Badge } from "@/components/ui";
import { RunCrawlButton } from "@/components/RunCrawlButton";
import { SourceToggle } from "@/components/sources/SourceToggle";
import { SetupNotice } from "@/components/SetupNotice";
import { SOURCE_STATUS_STYLES } from "@/lib/status";
import { fmtDateTime, titleCase } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function SourcesPage() {
  if (!dbConfigured) {
    return (
      <>
        <PageHeader title="Sources" subtitle="Portals, schedules & connector health" />
        <SetupNotice />
      </>
    );
  }
  const [sources, runs] = await Promise.all([listSourceHealth(), getAllCrawlRuns(20)]);

  return (
    <>
      <PageHeader
        title="Sources"
        subtitle="One connector per portal · daily schedule · health monitoring"
        actions={
          <>
            <RunCrawlButton label="Run all" variant="ghost" />
            <Link href="/sources/new" className="btn btn-primary"><Plus size={15} /> Add portal</Link>
          </>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        {sources.map((s) => {
          const st = SOURCE_STATUS_STYLES[s.status];
          const run = s.last_run;
          return (
            <Card key={s.id} className="p-5">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-[0.98rem] font-semibold text-[var(--color-ink)]">{s.name}</h3>
                    <Badge label={st.label} bg={st.bg} fg={st.fg} dot={st.dot} />
                  </div>
                  <div className="text-[0.75rem] text-[var(--color-faint)] mt-0.5 flex items-center gap-2 flex-wrap">
                    <span className="chip">{s.state ?? "—"}</span>
                    <span className="chip">{titleCase(s.connector_type)}</span>
                    <span className="font-mono">{s.schedule_cron}</span>
                  </div>
                </div>
                <a href={s.base_url} target="_blank" rel="noreferrer" className="text-[var(--color-faint)] hover:text-[var(--color-brand-600)]">
                  <ExternalLink size={16} />
                </a>
              </div>

              <div className="grid grid-cols-3 gap-2 mt-4">
                <Mini label="Open" value={s.open_count} />
                <Mini label="New" value={s.new_count} />
                <Mini label="Total" value={s.total_count} />
              </div>

              <div className="mt-4 pt-3 border-t border-[var(--color-border)] flex items-center justify-between">
                <div className="text-[0.75rem] text-[var(--color-muted)]">
                  {run ? (
                    <span className="flex items-center gap-1.5">
                      {run.status === "failed" ? (
                        <AlertTriangle size={13} className="text-[var(--color-rose-500)]" />
                      ) : (
                        <CheckCircle2 size={13} className="text-[var(--color-mint-500)]" />
                      )}
                      Last run {fmtDateTime(run.started_at)} · {run.items_found} found, {run.new_count} new
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5"><Clock size={13} /> Never run</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <SourceToggle id={s.id} isActive={s.is_active} />
                  <RunCrawlButton source={s.slug} label="Run now" variant="soft" />
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader title="Recent crawl runs" subtitle="Monitoring feed — items found, new, changed, closed, errors" action={<Activity size={15} className="text-[var(--color-faint)]" />} />
        <div className="overflow-x-auto">
          <table className="w-full text-[0.82rem]">
            <thead>
              <tr className="text-left text-[0.7rem] uppercase tracking-wide text-[var(--color-faint)] border-b border-[var(--color-border)]">
                <th className="py-2.5 px-5 font-semibold">Source</th>
                <th className="py-2.5 px-3 font-semibold">Started</th>
                <th className="py-2.5 px-3 font-semibold">Status</th>
                <th className="py-2.5 px-3 font-semibold text-right">Found</th>
                <th className="py-2.5 px-3 font-semibold text-right">New</th>
                <th className="py-2.5 px-3 font-semibold text-right">Changed</th>
                <th className="py-2.5 px-3 font-semibold text-right">Closed</th>
                <th className="py-2.5 px-3 font-semibold text-right">Duration</th>
              </tr>
            </thead>
            <tbody>
              {runs.length === 0 && (
                <tr><td colSpan={8} className="py-6 text-center text-[var(--color-muted)]">No crawl runs yet — trigger one above.</td></tr>
              )}
              {runs.map((r) => (
                <tr key={r.id} className="border-b border-[var(--color-border)]">
                  <td className="py-2.5 px-5 font-medium text-[var(--color-ink-2)]">{r.source_name ?? "—"}</td>
                  <td className="py-2.5 px-3 text-[var(--color-muted)]">{fmtDateTime(r.started_at)}</td>
                  <td className="py-2.5 px-3">
                    <span className="badge" style={runStatusStyle(r.status)}>{r.status}</span>
                  </td>
                  <td className="py-2.5 px-3 text-right tabular-nums">{r.items_found}</td>
                  <td className="py-2.5 px-3 text-right tabular-nums text-[var(--color-brand-600)]">{r.new_count}</td>
                  <td className="py-2.5 px-3 text-right tabular-nums">{r.changed_count}</td>
                  <td className="py-2.5 px-3 text-right tabular-nums">{r.closed_count}</td>
                  <td className="py-2.5 px-3 text-right tabular-nums text-[var(--color-faint)]">{r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

function Mini({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-center">
      <div className="text-[1.1rem] font-semibold text-[var(--color-ink)]">{value}</div>
      <div className="text-[0.68rem] text-[var(--color-faint)] uppercase tracking-wide">{label}</div>
    </div>
  );
}

function runStatusStyle(status: string): { background: string; color: string } {
  if (status === "success") return { background: "var(--color-mint-100)", color: "var(--color-mint-700)" };
  if (status === "partial") return { background: "var(--color-amber-100)", color: "var(--color-amber-700)" };
  if (status === "failed") return { background: "var(--color-rose-100)", color: "var(--color-rose-700)" };
  return { background: "#eef0f4", color: "#5b6170" };
}
