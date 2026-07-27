import { CalendarClock, Telescope } from "lucide-react";
import { dbConfigured } from "@/lib/supabase/server";
import { pageGate } from "@/lib/auth/page-gate";
import { listForecastOpportunities } from "@/lib/db/forecast";
import { Card, PageHeader, EmptyState, Stat } from "@/components/ui";
import { ForecastTable } from "@/components/forecast/ForecastTable";
import { SetupNotice } from "@/components/SetupNotice";
import { daysUntil } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * Forecast — the "Forecased Opportunities" [sic] sheet.
 *
 * Work that agencies have published in their acquisition forecast but have NOT
 * solicited yet: no RFx number, no due date, no portal listing to crawl. It is
 * the front of the funnel, which is why it is a page of its own rather than a
 * filter on Opportunities — a forecast row cannot carry a capture stage or a
 * solicitation status, and putting it in the same list would force fake ones.
 */
export default async function ForecastPage() {
  if (!dbConfigured) {
    return (
      <>
        <PageHeader title="Forecast" subtitle="Agency forecasts — opportunities not yet solicited" />
        <SetupNotice />
      </>
    );
  }
  const { deny } = await pageGate();
  if (deny) return deny;

  const rows = await listForecastOpportunities();

  if (rows === null) {
    return (
      <>
        <PageHeader title="Forecast" subtitle="Agency forecasts — opportunities not yet solicited" />
        <Card>
          <EmptyState
            icon={<Telescope size={32} />}
            title="Forecast table not created yet"
            description="The forecast_opportunities table is created by deploy/db/migrations/001-pipeline-2026.sql. Apply that migration against the database, then reload this page."
          />
        </Card>
      </>
    );
  }

  const withinQuarter = rows.filter((r) => {
    const d = daysUntil(r.estimated_solicitation_date);
    return d !== null && d >= 0 && d <= 90;
  }).length;
  const setAside = rows.filter((r) => r.set_asides?.length > 0).length;
  const departments = new Set(rows.map((r) => r.department).filter(Boolean)).size;

  return (
    <>
      <PageHeader
        title="Forecast"
        subtitle="Published agency forecasts — the front of the funnel, before anything is solicited"
      />

      {rows.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <Stat label="Forecast items" value={rows.length} icon={<Telescope size={15} />} />
          <Stat
            label="Solicits within 90 days"
            value={withinQuarter}
            hint="Capture work should already be underway"
            icon={<CalendarClock size={15} />}
          />
          <Stat label="With a set-aside" value={setAside} hint="8(a), WOSB, SDVOSB…" />
          <Stat label="Departments" value={departments} />
        </div>
      )}

      <Card>
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--color-border)]">
          <span className="text-[0.82rem] text-[var(--color-muted)]">
            <span className="font-semibold text-[var(--color-ink)]">{rows.length}</span> forecast item
            {rows.length === 1 ? "" : "s"} · soonest first
          </span>
        </div>
        {rows.length ? (
          <ForecastTable rows={rows} />
        ) : (
          <EmptyState
            icon={<Telescope size={32} />}
            title="No forecast items yet"
            description="Forecast entries come from agency acquisition forecasts — e.g. acquisitiongateway.gov — and are tracked here until they turn into a real solicitation, at which point they get promoted into the pipeline."
          />
        )}
      </Card>
    </>
  );
}
