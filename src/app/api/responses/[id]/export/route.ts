import { NextRequest, NextResponse } from "next/server";
import { getResponse } from "@/lib/db/responses";
import { getOpportunity } from "@/lib/db/opportunities";
import { markdownToDocxBuffer } from "@/lib/export/docx";

export const runtime = "nodejs";

/** GET /api/responses/:id/export — download the draft as a Word .docx. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const resp = await getResponse(id);
  if (!resp) return NextResponse.json({ error: "Response not found" }, { status: 404 });
  const opp = await getOpportunity(resp.opportunity_id);
  const title = opp ? `${opp.title} — ${opp.external_id}` : resp.title || "Proposal";

  const buf = await markdownToDocxBuffer(title, resp.content);
  const safe = (opp?.external_id || resp.id).replace(/[^a-z0-9-]+/gi, "_");
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="AJACE_Response_${safe}.docx"`,
    },
  });
}
