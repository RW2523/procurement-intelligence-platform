import Link from "next/link";
import { Briefcase, Plus } from "lucide-react";
import { dbConfigured } from "@/lib/supabase/server";
import { getSourceBySlug } from "@/lib/crawl/runner";
import { listOpportunities } from "@/lib/db/opportunities";
import { Card, PageHeader, EmptyState } from "@/components/ui";
import { OpportunityTable } from "@/components/opportunities/OpportunityTable";
import { SetupNotice } from "@/components/SetupNotice";

export const dynamic = "force-dynamic";

/**
 * My Bids — the team's current pipeline, added manually. Same data model and
 * workspace as crawled opportunities, so nothing lives in a separate silo.
 */
export default async function MyBidsPage() {
  if (!dbConfigured) {
    return (
      <>
        <PageHeader title="My Bids" subtitle="Bids your team is already working on" />
        <SetupNotice />
      </>
    );
  }

  const source = await getSourceBySlug("manual");
  const bids = source
    ? await listOpportunities({ sourceId: source.id, sort: "newest", limit: 200 })
    : [];

  return (
    <>
      <PageHeader
        title="My Bids"
        subtitle="Bids already in your pipeline — uploaded by the team, tracked alongside crawled opportunities"
        actions={
          <Link href="/my-bids/new" className="btn btn-primary">
            <Plus size={15} /> Add a bid
          </Link>
        }
      />
      <Card>
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--color-border)]">
          <span className="text-[0.82rem] text-[var(--color-muted)]">
            <span className="font-semibold text-[var(--color-ink)]">{bids.length}</span> bid{bids.length === 1 ? "" : "s"} in your pipeline
          </span>
        </div>
        {bids.length ? (
          <OpportunityTable opps={bids} />
        ) : (
          <EmptyState
            icon={<Briefcase size={32} />}
            title="No bids uploaded yet"
            description="Add the bids your team is already working on — they get the same workspace, documents, AI drafts, and status tracking as crawled opportunities."
            action={
              <Link href="/my-bids/new" className="btn btn-soft">
                <Plus size={15} /> Add your first bid
              </Link>
            }
          />
        )}
      </Card>
    </>
  );
}
