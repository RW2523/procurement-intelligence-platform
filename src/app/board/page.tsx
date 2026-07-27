import { dbConfigured } from "@/lib/supabase/server";
import { pageGate } from "@/lib/auth/page-gate";
import { getBoard } from "@/lib/db/opportunities";
import { PIPELINE_STAGES } from "@/lib/types";
import { PIPELINE_STYLES } from "@/lib/status";
import { PageHeader } from "@/components/ui";
import { BoardClient } from "@/components/board/BoardClient";
import { SetupNotice } from "@/components/SetupNotice";
import { RunCrawlButton } from "@/components/RunCrawlButton";

export const dynamic = "force-dynamic";

/**
 * Derived from PIPELINE_STAGES rather than typed out: the previous subtitle
 * hardcoded the retired flow ("New → Reviewing → Drafting → …") and no grep for
 * a stage identifier could find it, so it stayed wrong for the whole life of the
 * old vocabulary. Building it from the array means the copy can never drift from
 * the board columns again.
 */
const STAGE_FLOW = PIPELINE_STAGES.map((s) => PIPELINE_STYLES[s].label).join(" → ");

export default async function BoardPage() {
  if (!dbConfigured) {
    return (
      <>
        <PageHeader title="Pipeline Board" subtitle="Move opportunities through the lifecycle" />
        <SetupNotice />
      </>
    );
  }
  const { deny } = await pageGate();
  if (deny) return deny;
  const board = await getBoard();
  return (
    <>
      <PageHeader
        title="Pipeline Board"
        subtitle={`${STAGE_FLOW}. Drag cards or use the dropdown; every move is logged.`}
        actions={<RunCrawlButton label="Run all crawls" variant="ghost" />}
      />
      <BoardClient board={board} />
    </>
  );
}
