import { Inbox } from "lucide-react";
import { dbConfigured } from "@/lib/supabase/server";
import { listOpportunities, type OppFilters } from "@/lib/db/opportunities";
import { listFilterStates } from "@/lib/db/states";
import { Card, PageHeader, EmptyState } from "@/components/ui";
import { OpportunityTable } from "@/components/opportunities/OpportunityTable";
import { OpportunityFilters } from "@/components/opportunities/OpportunityFilters";
import { RunCrawlButton } from "@/components/RunCrawlButton";
import { SetupNotice } from "@/components/SetupNotice";

export const dynamic = "force-dynamic";

export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!dbConfigured) {
    return (
      <>
        <PageHeader title="Opportunities" subtitle="Deduped master list across all portals" />
        <SetupNotice />
      </>
    );
  }

  const sp = await searchParams;
  const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

  // The state options are every state that can actually appear on a row, in the
  // exact casing it is STORED in. This deliberately spans BOTH `sources.state`
  // (crawled rows) and `opportunities.state` (hand-entered rows) — building it
  // from sources alone left CA, FL, MN, NY and VA with no <option> at all, so 17
  // of the operator's 71 typed-in rows were reachable only by hand-editing
  // "?state=NY" into the address bar. See src/lib/db/states.ts.
  const states = await listFilterStates();

  // Canonicalise "?state=" against those stored values so a differently-cased
  // link (?state=nc) filters correctly instead of returning an empty list. An
  // unknown code is passed through unchanged: no source has it, so an empty
  // result is the honest answer rather than a silently-dropped filter.
  const stateParam = str(sp.state);
  const stateFilter = stateParam
    ? states.find((s) => s.trim().toUpperCase() === stateParam.trim().toUpperCase()) ?? stateParam
    : undefined;

  // Default view: the targeting engine's actionable shortlist — Pursue + Capture
  // review with at least 10 calendar days to respond (§10) — PLUS every
  // hand-entered row. "?view=" overrides.
  //
  // The hand-entered half is why `includeHandEntered` exists. The shortlist is a
  // triage of what the crawlers found; a row the operator typed into
  // Pipeline_2026.xlsx has already been triaged by a human, so gating it on the
  // engine's verdict hides work that is already being worked. It is not
  // theoretical: none of the operator's 71 rows scores anywhere near the
  // captureReview threshold, so before this the default page — and therefore the
  // department filter they asked for — showed zero of them.
  //
  // Only ACTIONABLE gets the exemption. "?view=PURSUE" and the other single-bucket
  // views are direct questions about engine output and must answer with engine
  // output, hand-entered or not.
  const view = str(sp.view) ?? "ACTIONABLE";
  // `department` is declared here as well as (eventually) on OppFilters: the
  // intersection keeps this page compiling whether or not the field has landed
  // in OppFilters yet, and is a no-op once it has.
  const filters: OppFilters & { department?: string } = {
    q: str(sp.q),
    state: stateFilter,
    department: str(sp.department),
    stage: str(sp.stage),
    status: str(sp.status),
    urgency: str(sp.urgency),
    setAside: str(sp.setAside),
    vehicle: str(sp.vehicle),
    sort: (str(sp.sort) as OppFilters["sort"]) ?? "score",
    bucket: view === "ALL" ? undefined : view,
    minDays: view === "ACTIONABLE" || view === "PURSUE" || view === "CAPTURE_REVIEW" ? 10 : undefined,
    includeHandEntered: view === "ACTIONABLE",
    limit: 400,
  };
  const opps = await listOpportunities(filters);

  return (
    <>
      <PageHeader
        title="Opportunities"
        subtitle="Deduped master list across all connected portals"
        actions={<RunCrawlButton label="Run all crawls" variant="ghost" />}
      />
      <OpportunityFilters states={states} />
      <Card>
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--color-border)]">
          <span className="text-[0.82rem] text-[var(--color-muted)]">
            <span className="font-semibold text-[var(--color-ink)]">{opps.length}</span> opportunities
          </span>
        </div>
        {opps.length ? (
          <OpportunityTable opps={opps} />
        ) : (
          <EmptyState
            icon={<Inbox size={32} />}
            title="No opportunities match"
            description="Adjust the filters, or run a crawl to discover new postings."
            action={<RunCrawlButton label="Run all crawls" variant="soft" />}
          />
        )}
      </Card>
    </>
  );
}
