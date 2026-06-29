import { NextRequest, NextResponse } from "next/server";
import { getServiceClient, dbConfigured } from "@/lib/supabase/server";

export const runtime = "nodejs";

/** GET /api/attachments/:id/text — the extracted document text (for the text preview). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!dbConfigured) return NextResponse.json({ error: "DB not configured" }, { status: 503 });
  const { id } = await params;
  const sb = getServiceClient();
  const { data } = await sb.from("attachments").select("filename, parsed_text").eq("id", id).maybeSingle();
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ filename: data.filename, text: data.parsed_text ?? "" });
}
