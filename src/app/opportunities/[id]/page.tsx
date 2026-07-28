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
  User,
  Mail,
  Phone,
  CalendarRange,
  Landmark,
  FileSignature,
  ClipboardList,
  Trophy,
  Lightbulb,
  Share2,
  Search,
} from "lucide-react";
import { dbConfigured } from "@/lib/supabase/server";
import { pageGate } from "@/lib/auth/page-gate";
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
import { MissingDetails } from "@/components/opportunities/MissingDetails";
import { DocumentsPanel } from "@/components/opportunities/DocumentsPanel";
import { ResponseWorkspace, type ResponseWithRevisions } from "@/components/responses/ResponseWorkspace";
import { SetupNotice } from "@/components/SetupNotice";
import {
  OPP_STATUS_STYLES,
  pipelineStyle,
  pipelineLabel,
  relevanceStyle,
  BID_REC_STYLES,
  BUCKET_STYLES,
} from "@/lib/status";
import { fmtDate, fmtDateTime, deadlineLabel, fmtCurrency, daysUntil } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * The sheet's "Website" column is not always a URL — real cells include
 * "Email from 3/23/26 from Anita" and "5/15/26https://www.nyscr.ny.gov/…".
 * Rendering those as an <a href> would emit a relative link that, under the
 * /procurement basePath, resolves to a 404 inside this app. Only linkify what is
 * genuinely an absolute http(s) URL; show anything else as plain text.
 */
function httpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export default async function OpportunityDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!dbConfigured) return <SetupNotice />;
  // opportunities/layout.tsx gates entry into this segment, but Next reuses a
  // mounted layout across navigations within it (docs 01-app/02-guides/authentication.md:1350),
  // so moving between two opportunities would otherwise skip the check.
  const { deny, user } = await pageGate();
  if (deny) return deny;

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
  // pipelineStyle(), not PIPELINE_STYLES[…]: a row still holding a retired value
  // (BACKLOG/DRAFTING/DECLINED) would make the unguarded lookup a runtime
  // TypeError on this page. The helper maps them and falls back to neutral.
  const stage = pipelineStyle(opp.pipeline_stage);
  const rel = relevanceStyle(opp.relevance_score);
  const dDue = daysUntil(opp.due_date);
  const closing = dDue !== null && dDue >= 0 && dDue <= 7;
  const dQa = daysUntil(opp.q_and_a_deadline);
  const portalUrl = httpUrl(opp.detail_url);
  const orgLine = [opp.department, opp.sub_agency].filter(Boolean).join(" / ");
  const hasPoc = !!(opp.poc_raw || opp.poc_name || opp.poc_email || opp.poc_phone);

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
            {/* Hand-entered rows sit on the 'manual' source, which has state = null —
                fall back to the row's own state column so they are not blank. */}
            <span className="chip">
              {opp.source?.name}
              {(opp.source?.state ?? opp.state) ? ` · ${opp.source?.state ?? opp.state}` : ""}
            </span>
            {opp.is_shared && (
              <span className="chip">
                <Share2 size={11} /> Shared
              </span>
            )}
          </div>
          <h1 className="text-[1.4rem] font-semibold tracking-tight text-[var(--color-ink)] leading-snug">{opp.title}</h1>
          <div className="text-[0.85rem] text-[var(--color-muted)] mt-1">
            <span className="font-mono">{opp.external_id}</span>
            {orgLine && <> · {orgLine}</>}
            {opp.agency && <> · {opp.agency}</>}
          </div>
        </div>
        {portalUrl && (
          <a href={portalUrl} target="_blank" rel="noreferrer" className="btn btn-ghost shrink-0">
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

          {(opp.capture_notes || opp.outcome || opp.lessons_learned) && (
            <Card>
              <CardHeader
                title="Capture tracking"
                subtitle="Your own follow-up log, outcome and takeaways"
                action={<ClipboardList size={16} className="text-[var(--color-faint)]" />}
              />
              <div className="px-5 py-4 space-y-4">
                {opp.capture_notes && (
                  <Block
                    icon={<ClipboardList size={14} />}
                    label="Status / follow-ups"
                    value={opp.capture_notes}
                  />
                )}
                {opp.outcome && (
                  <Block
                    icon={<Trophy size={14} />}
                    label="Won / Loss"
                    hint="Recorded separately from the capture stage — the two are different axes."
                    value={opp.outcome}
                  />
                )}
                {opp.lessons_learned && (
                  <Block icon={<Lightbulb size={14} />} label="Lessons learned" value={opp.lessons_learned} />
                )}
              </div>
            </Card>
          )}

          {hasPoc && (
            <Card>
              <CardHeader
                title="Point of contact"
                subtitle="As recorded on the opportunity — kept out of the searchable agency field"
                action={<User size={16} className="text-[var(--color-faint)]" />}
              />
              <div className="px-5 py-4 space-y-3">
                {opp.poc_name && <Detail icon={<User size={14} />} label="Name" value={opp.poc_name} />}
                {opp.poc_email && (
                  <Detail
                    icon={<Mail size={14} />}
                    label="Email"
                    value={
                      <a href={`mailto:${opp.poc_email}`} className="text-[var(--color-brand-600)] hover:underline">
                        {opp.poc_email}
                      </a>
                    }
                  />
                )}
                {opp.poc_phone && <Detail icon={<Phone size={14} />} label="Phone" value={opp.poc_phone} />}
                {opp.poc_raw && (
                  <Block icon={<Building2 size={14} />} label="Contact block (verbatim)" value={opp.poc_raw} />
                )}
              </div>
            </Card>
          )}

          <MissingDetails
            bid={opp as unknown as Record<string, unknown>}
            canEdit={user?.role === "writer" || user?.role === "approver" || user?.role === "admin"}
          />
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
              {/* Deadlines. Where the row carries the hand-typed cell (*_text),
                  that string is the truth and the parsed instant is shown under
                  it — several sheet cells hold two dates or a caveat, so the
                  wording must survive verbatim. */}
              <Detail icon={<Calendar size={14} />} label="Response due" value={
                <>
                  <span className={closing ? "text-[var(--color-rose-700)] font-medium" : ""}>
                    {opp.due_date_text ?? fmtDateTime(opp.due_date)}
                  </span>
                  <div className="text-[0.72rem] text-[var(--color-faint)]">
                    {opp.due_date_text && opp.due_date ? `${fmtDateTime(opp.due_date)} · ` : ""}
                    {deadlineLabel(opp.due_date)}
                  </div>
                </>
              } />
              <Detail icon={<Clock size={14} />} label="Questions due" value={
                (opp.q_and_a_deadline_text ?? opp.q_and_a_deadline) ? (
                  <>
                    <span className={dQa !== null && dQa >= 0 && dQa <= 3 ? "text-[var(--color-amber-700)] font-medium" : ""}>
                      {opp.q_and_a_deadline_text ?? fmtDateTime(opp.q_and_a_deadline)}
                    </span>
                    {opp.q_and_a_deadline_text && opp.q_and_a_deadline && (
                      <div className="text-[0.72rem] text-[var(--color-faint)]">{fmtDateTime(opp.q_and_a_deadline)}</div>
                    )}
                  </>
                ) : "—"
              } />
              <Detail icon={<CalendarRange size={14} />} label="Period of performance" value={opp.period_of_performance ?? "—"} />
              <Detail icon={<Calendar size={14} />} label="Posted" value={fmtDate(opp.posted_date)} />
              <Detail icon={<Search size={14} />} label="Date found" value={fmtDate(opp.date_found)} />
              <Detail icon={<Landmark size={14} />} label="Department" value={orgLine || "—"} />
              <Detail icon={<Building2 size={14} />} label="Agency" value={opp.agency ?? "—"} />
              <Detail icon={<FileSignature size={14} />} label="Contract vehicle" value={opp.contract_vehicle ?? "—"} />
              <Detail icon={<Tag size={14} />} label="Category" value={opp.category ?? "—"} />
              <Detail icon={<Tag size={14} />} label="NAICS" value={
                opp.naics_codes?.length ? opp.naics_codes.join(" · ") : opp.naics_code ?? "—"
              } />
              <Detail icon={<Tag size={14} />} label="Set-aside" value={
                opp.set_asides?.length ? opp.set_asides.join(" · ") : "—"
              } />
              <Detail icon={<DollarSign size={14} />} label="Est. value" value={
                opp.estimated_value_text ?? fmtCurrency(opp.estimated_value)
              } />
              <Detail icon={<Share2 size={14} />} label="Share / No share" value={opp.is_shared ? "Shared" : "Not shared"} />
              <Detail icon={<FileText size={14} />} label="RFx #" value={
                opp.rfx_number_raw ? (
                  <span className="whitespace-pre-wrap">{opp.rfx_number_raw}</span>
                ) : (
                  <span className="font-mono">{opp.external_id}</span>
                )
              } />
              {/* Non-URL "Website" cells (e.g. "Email from 3/23 from Anita") are
                  shown as text; the linked version is the header button. */}
              {opp.detail_url && !portalUrl && (
                <Detail icon={<ExternalLink size={14} />} label="Listing" value={opp.detail_url} />
              )}
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
                    {/* Stage values are mapped through pipelineLabel() because
                        old_value/new_value are free text and older rows can hold
                        retired vocabulary (BACKLOG/DRAFTING/DECLINED). */}
                    <span className="text-[var(--color-ink-2)]">
                      {l.field === "pipeline_stage" ? "Stage" : "Status"}:{" "}
                      {l.field === "pipeline_stage" ? pipelineLabel(l.old_value) : l.old_value ?? "—"} →{" "}
                      <span className="font-medium">
                        {l.field === "pipeline_stage" ? pipelineLabel(l.new_value) : l.new_value}
                      </span>
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

/** A multi-line free-text field. `whitespace-pre-wrap` matters: the sheet's
 *  notes and contact blocks carry their own line breaks and lose their meaning
 *  when collapsed onto one line. */
function Block({
  icon,
  label,
  hint,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  value: string;
}) {
  return (
    <div>
      <div className="text-[0.72rem] uppercase tracking-wide text-[var(--color-faint)] flex items-center gap-1.5">
        <span>{icon}</span>
        {label}
      </div>
      {hint && <div className="text-[0.72rem] text-[var(--color-faint)] mt-0.5">{hint}</div>}
      <div className="text-[0.85rem] text-[var(--color-ink-2)] mt-1 whitespace-pre-wrap leading-relaxed">
        {value}
      </div>
    </div>
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
