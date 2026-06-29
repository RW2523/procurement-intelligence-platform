import { NextRequest, NextResponse } from "next/server";
import { getServiceClient, dbConfigured } from "@/lib/supabase/server";
import { fetchOpportunityDocuments } from "@/lib/crawl/attachments";

export const runtime = "nodejs";
export const maxDuration = 120;

const SELECT =
  "id, filename, content_type, byte_size, parse_status, downloaded_at, source_url, fetch_error, parsed_text";

/** GET — list an opportunity's documents (metadata only, no bytes). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!dbConfigured) return NextResponse.json({ error: "DB not configured" }, { status: 503 });
  const { id } = await params;
  const sb = getServiceClient();
  const { data } = await sb.from("attachments").select(SELECT).eq("opportunity_id", id).order("created_at");
  return NextResponse.json({ attachments: data ?? [] });
}

/** POST — discover (if needed) + download + parse this opportunity's documents. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!dbConfigured) return NextResponse.json({ error: "DB not configured" }, { status: 503 });
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const result = await fetchOpportunityDocuments(id, { max: Math.min(Number(body.max) || 8, 15) });
  const sb = getServiceClient();
  const { data } = await sb.from("attachments").select(SELECT).eq("opportunity_id", id).order("created_at");
  return NextResponse.json({ result, attachments: data ?? [] });
}
