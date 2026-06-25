import { dbConfigured } from "@/lib/supabase/server";
import { getBoard } from "@/lib/db/opportunities";
import { PageHeader } from "@/components/ui";
import { BoardClient } from "@/components/board/BoardClient";
import { SetupNotice } from "@/components/SetupNotice";
import { RunCrawlButton } from "@/components/RunCrawlButton";

export const dynamic = "force-dynamic";

export default async function BoardPage() {
  if (!dbConfigured) {
    return (
      <>
        <PageHeader title="Pipeline Board" subtitle="Move opportunities through the lifecycle" />
        <SetupNotice />
      </>
    );
  }
  const board = await getBoard();
  return (
    <>
      <PageHeader
        title="Pipeline Board"
        subtitle="New → Reviewing → Drafting → Approved → Submitted → Won / Lost. Drag cards or use the dropdown; every move is logged."
        actions={<RunCrawlButton label="Run all crawls" variant="ghost" />}
      />
      <BoardClient board={board} />
    </>
  );
}
