import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  ExternalLink,
  Calendar,
  DollarSign,
  Building2,
  Tag,
  Clock,
  History,
  ScrollText,
  FileText,
} from "lucide-react";
import { dbConfigured } from "@/lib/supabase/server";
import {
  getOpportunity,
  getAttachments,
  getVersions,
  getStatusLog,
} from "@/lib/db/opportunities";
import { getResponsesForOpp, getRevisions } from "@/lib/db/responses";
import { listUsers } from "@/lib/db/users";
import { Card, CardHeader, Badge, RelevanceBar } from "@/components/ui";
import { StatusControls } from "@/components/opportunities/StatusControls";
import { ScoreBreakdown } from "@/components/opportunities/ScoreBreakdown";
import { DocumentsPanel } from "@/components/opportunities/DocumentsPanel";
import { ResponseWorkspace, type ResponseWithRevisions } from "@/components/responses/ResponseWorkspace";
import { SetupNotice } from "@/components/SetupNotice";
import { OPP_STATUS_STYLES, PIPELINE_STYLES, relevanceStyle, BID_REC_STYLES, BUCKET_STYLES } from "@/lib/status";
import { fmtDate, fmtDateTime, deadlineLabel, fmtCurrency, daysUntil } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function OpportunityDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!dbConfigured) return <SetupNotice />;

  const opp = await getOpportunity(id);
  if (!opp) notFound();

  const [attachments, versions, statusLog, responses, users] = await Promise.all([
    getAttachments(id),
    getVersions(id),
    getStatusLog(id),
    getResponsesForOpp(id),
    listUsers(),
  ]);
  const responsesWithRev: ResponseWithRevisions[] = await Promise.all(
    responses.map(async (r) => ({ ...r, revisions: await getRevisions(r.id) })),
  );

  const st = OPP_STATUS_STYLES[opp.status];
  const stage = PIPELINE_STYLES[opp.pipeline_stage];
  const rel = relevanceStyle(opp.relevance_score);
  const dDue = daysUntil(opp.due_date);
  const closing = dDue !== null && dDue >= 0 && dDue <= 7;
  const dQa = daysUntil(opp.q_and_a_deadline);

  return (
    <>
      <Link href="/opportunities" className="inline-flex items-center gap-1.5 text-[0.82rem] text-[var(--color-muted)] hover:text-[var(--color-ink)] mb-3">
        <ArrowLeft size={15} /> All opportunities
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1.5">
            <Badge label={st.label} bg={st.bg} fg={st.fg} dot={st.dot} />
            <Badge label={stage.label} bg={stage.bg} fg={stage.fg} dot={stage.dot} />
            {opp.pursuit_bucket && (
              <Badge
                label={`${opp.pursuit_score} · ${BUCKET_STYLES[opp.pursuit_bucket].label}`}
                bg={BUCKET_STYLES[opp.pursuit_bucket].bg}
                fg={BUCKET_STYLES[opp.pursuit_bucket].fg}
                dot={BUCKET_STYLES[opp.pursuit_bucket].dot}
              />
            )}
            <Badge label={rel.label} bg={rel.bg} fg={rel.fg} />
            <span className="chip">{opp.source?.name}{opp.source?.state ? ` · ${opp.source.state}` : ""}</span>
          </div>
          <h1 className="text-[1.4rem] font-semibold tracking-tight text-[var(--color-ink)] leading-snug">{opp.title}</h1>
          <div className="text-[0.85rem] text-[var(--color-muted)] mt-1">
            <span className="font-mono">{opp.external_id}</span>
            {opp.agency && <> · {opp.agency}</>}
          </div>
        </div>
        {opp.detail_url && (
          <a href={opp.detail_url} target="_blank" rel="noreferrer" className="btn btn-ghost shrink-0">
            <ExternalLink size={15} /> View on portal
          </a>
        )}
      </div>

      <Card className="px-4 py-3 mb-5">
        <StatusControls oppId={opp.id} status={opp.status} stage={opp.pipeline_stage} assignedTo={opp.assigned_to} users={users} />
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 space-y-5">
          <Card>
            <CardHeader title="Solicitation overview" />
            <div className="px-5 py-4 text-[0.88rem] leading-relaxed text-[var(--color-ink-2)] whitespace-pre-wrap">
              {opp.description || "No description was captured from the portal listing. Open the portal page or attachments for full scope."}
            </div>
            {opp.relevance_reason && (
              <div className="px-5 pb-4">
                <div className="text-[0.72rem] uppercase tracking-wide text-[var(--color-faint)] mb-1 flex items-center gap-2">
                  {opp.relevance_method === "llm" ? "AI bid / no-bid assessment" : "Relevance assessment"}
                  {opp.bid_recommendation && (
                    <Badge
                      label={BID_REC_STYLES[opp.bid_recommendation].label}
                      bg={BID_REC_STYLES[opp.bid_recommendation].bg}
                      fg={BID_REC_STYLES[opp.bid_recommendation].fg}
                      dot={BID_REC_STYLES[opp.bid_recommendation].dot}
                    />
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <RelevanceBar score={opp.relevance_score} />
                  <span className="text-[0.82rem] text-[var(--color-muted)]">{opp.relevance_reason}</span>
                </div>
              </div>
            )}
          </Card>

          <ScoreBreakdown opp={opp} />

          <Card>
            <CardHeader
              title="Response workspace"
              subtitle="Two AI drafts · edit · request changes · approve · export"
              action={<FileText size={16} className="text-[var(--color-faint)]" />}
            />
            <div className="p-5">
              <ResponseWorkspace opportunityId={opp.id} responses={responsesWithRev} />
            </div>
          </Card>

          <DocumentsPanel opportunityId={opp.id} initial={attachments} />
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Key details" />
            <div className="px-5 py-4 space-y-3">
              <Detail icon={<Calendar size={14} />} label="Response due" value={
                <span className={closing ? "text-[var(--color-rose-700)] font-medium" : ""}>
                  {fmtDateTime(opp.due_date)} <span className="text-[0.72rem] text-[var(--color-faint)]">· {deadlineLabel(opp.due_date)}</span>
                </span>
              } />
              <Detail icon={<Clock size={14} />} label="Q&A deadline" value={
                opp.q_and_a_deadline ? (
                  <span className={dQa !== null && dQa >= 0 && dQa <= 3 ? "text-[var(--color-amber-700)] font-medium" : ""}>
                    {fmtDateTime(opp.q_and_a_deadline)}
                  </span>
                ) : "—"
              } />
              <Detail icon={<Calendar size={14} />} label="Posted" value={fmtDate(opp.posted_date)} />
              <Detail icon={<Building2 size={14} />} label="Agency" value={opp.agency ?? "—"} />
              <Detail icon={<Tag size={14} />} label="Category" value={opp.category ?? opp.naics_code ?? "—"} />
              <Detail icon={<DollarSign size={14} />} label="Est. value" value={fmtCurrency(opp.estimated_value)} />
              <Detail icon={<Clock size={14} />} label="First seen" value={fmtDateTime(opp.first_seen_at)} />
              <Detail icon={<Clock size={14} />} label="Last seen" value={fmtDateTime(opp.last_seen_at)} />
            </div>
          </Card>

          <Card>
            <CardHeader title="Version history" subtitle={`${versions.length} snapshot${versions.length === 1 ? "" : "s"}`} action={<History size={15} className="text-[var(--color-faint)]" />} />
            <div className="px-5 py-3 space-y-2.5">
              {versions.map((v) => (
                <div key={v.id} className="flex items-start gap-2.5">
                  <span className="mt-0.5 grid place-items-center w-6 h-6 rounded-full bg-[var(--color-brand-50)] text-[var(--color-brand-600)] text-[0.7rem] font-semibold shrink-0">v{v.version_no}</span>
                  <div className="min-w-0">
                    <div className="text-[0.82rem] text-[var(--color-ink-2)]">{v.change_summary ?? "Snapshot"}</div>
                    <div className="text-[0.7rem] text-[var(--color-faint)]">{fmtDateTime(v.captured_at)}</div>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader title="Audit trail" subtitle="Every status & stage change" action={<ScrollText size={15} className="text-[var(--color-faint)]" />} />
            <div className="px-5 py-3 space-y-2.5 max-h-[320px] overflow-y-auto">
              {statusLog.length === 0 && <div className="text-[0.82rem] text-[var(--color-muted)]">No changes logged yet.</div>}
              {statusLog.map((l) => (
                <div key={l.id} className="text-[0.8rem] flex items-start gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-brand-400)] mt-1.5 shrink-0" />
                  <div>
                    <span className="text-[var(--color-ink-2)]">
                      {l.field === "pipeline_stage" ? "Stage" : "Status"}: {l.old_value ?? "—"} → <span className="font-medium">{l.new_value}</span>
                    </span>
                    <div className="text-[0.7rem] text-[var(--color-faint)]">
                      {l.changed_by} · {fmtDateTime(l.changed_at)}{l.reason ? ` · ${l.reason}` : ""}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

function Detail({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="text-[var(--color-faint)] mt-0.5">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[0.72rem] uppercase tracking-wide text-[var(--color-faint)]">{label}</div>
        <div className="text-[0.85rem] text-[var(--color-ink-2)]">{value}</div>
      </div>
    </div>
  );
}
