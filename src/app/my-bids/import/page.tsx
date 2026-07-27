import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { dbConfigured } from "@/lib/supabase/server";
import { pageGate } from "@/lib/auth/page-gate";
import { PageHeader } from "@/components/ui";
import { SetupNotice } from "@/components/SetupNotice";
import { ImportWorkbook } from "@/components/bids/ImportWorkbook";

export const dynamic = "force-dynamic";

/**
 * Import a Pipeline workbook into My Bids.
 *
 * Gated at writer, matching /api/import/pipeline — a viewer who reaches this URL
 * gets the refusal element rather than a form that fails on submit.
 */
export default async function ImportBidsPage() {
  if (!dbConfigured) {
    return (
      <>
        <PageHeader title="Import bids" subtitle="Load a pipeline spreadsheet into My Bids" />
        <SetupNotice />
      </>
    );
  }
  const { deny } = await pageGate("writer");
  if (deny) return deny;

  return (
    <>
      <PageHeader
        title="Import bids from a spreadsheet"
        subtitle="Upload your pipeline workbook — every row becomes a bid you can track, with its capture stage, department and deadlines already filled in"
        actions={
          <Link href="/my-bids" className="btn btn-ghost">
            <ArrowLeft size={15} /> Back to My Bids
          </Link>
        }
      />

      <div className="card p-5 mb-5">
        <div className="text-[0.92rem] font-semibold mb-2">What the file needs to look like</div>
        <p className="text-[0.86rem] text-[var(--color-muted)] mb-3">
          The same layout your team already uses. The header row is found automatically, so it does
          not matter which row it sits on or whether there is a title banner above it. Columns are
          matched by name, so extra columns are ignored and a missing one just leaves that field empty.
        </p>
        <div style={{ overflowX: "auto" }}>
          <table className="w-full text-[0.82rem]">
            <thead>
              <tr className="text-left text-[var(--color-muted)]">
                <th className="px-3 py-1.5 font-semibold">Column in your sheet</th>
                <th className="px-3 py-1.5 font-semibold">Becomes</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["Share/No Share", "Whether the bid is shared with the team"],
                ["Date found", "When it entered the pipeline"],
                ["Agency/POC", "Agency, contact name, email and phone — split apart automatically"],
                ["Contract Vechicle", "Contract vehicle"],
                ["RFx #", "The solicitation number, used to match re-uploads"],
                ["Website", "Link to the posting"],
                ["Description", "Title and full description"],
                ["NAICS Code", "NAICS codes (several in one cell is fine)"],
                ["Period of Performance", "Period of performance"],
                ["Estimated Value", "Estimated value — text like “1.96B BPA” is kept as well as read as a number"],
                ["Set-Aside", "Set-aside categories"],
                ["Cature Stage", "Capture stage on the pipeline board"],
                ["Status", "Your follow-up notes"],
                ["Questions Due:", "Questions deadline"],
                ["Due Date", "Bid deadline"],
                ["Won/Loss", "Outcome"],
                ["Lessons Learned", "Lessons learned"],
              ].map(([from, to]) => (
                <tr key={from} className="border-t border-[var(--color-border)]">
                  <td className="px-3 py-1.5 whitespace-nowrap font-medium">{from}</td>
                  <td className="px-3 py-1.5 text-[var(--color-muted)]">{to}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[0.82rem] text-[var(--color-muted)] mt-3">
          A second sheet whose name contains “forecast” is picked up too, for opportunities that have
          not been solicited yet.
        </p>
      </div>

      <ImportWorkbook />
    </>
  );
}
