import { Inbox } from "lucide-react";
import { dbConfigured } from "@/lib/supabase/server";
import { listOpportunities, type OppFilters } from "@/lib/db/opportunities";
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
  const filters: OppFilters = {
    q: str(sp.q),
    state: str(sp.state),
    status: str(sp.status),
    sort: (str(sp.sort) as OppFilters["sort"]) ?? "newest",
    // "Strong fit only" is ON by default — show all only when explicitly turned off (?relevant=0).
    relevanceMin: str(sp.relevant) === "0" ? undefined : 70,
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
      <OpportunityFilters />
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
