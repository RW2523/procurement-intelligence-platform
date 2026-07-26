import { NextRequest, NextResponse } from "next/server";
import { getServiceClient, dbConfigured } from "@/lib/supabase/server";
import { requireRole, AuthError } from "@/lib/auth/guard";

export const runtime = "nodejs";

/** GET /api/attachments/:id/text — the extracted document text (for the text preview). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // API routes bypass the layout gate, so they must check for a
  // procurement account themselves.
  try { await requireRole("viewer"); }
  catch (e) { return Response.json({ error: e instanceof AuthError ? e.message : "forbidden" }, { status: 403 }); }

  if (!dbConfigured) return NextResponse.json({ error: "DB not configured" }, { status: 503 });
  const { id } = await params;
  const sb = getServiceClient();
  const { data } = await sb.from("attachments").select("filename, parsed_text").eq("id", id).maybeSingle();
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ filename: data.filename, text: data.parsed_text ?? "" });
}
