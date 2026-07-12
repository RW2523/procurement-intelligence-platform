import { NextRequest, NextResponse } from "next/server";
import { getServiceClient, dbConfigured } from "@/lib/supabase/server";
import { downloadDocument } from "@/lib/storage";

export const runtime = "nodejs";

/** GET /api/attachments/:id/file[?download=1] — serve a stored document for preview/download.
 *  Bytes come from Supabase Storage; legacy base64 rows are still served if present. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!dbConfigured) return NextResponse.json({ error: "DB not configured" }, { status: 503 });
  const { id } = await params;
  const sb = getServiceClient();
  const { data } = await sb
    .from("attachments")
    .select("filename, content_type, storage_path, file_base64")
    .eq("id", id)
    .maybeSingle();

  if (!data) return NextResponse.json({ error: "Attachment not found" }, { status: 404 });

  let buf: Buffer;
  if (data.storage_path) {
    try {
      buf = (await downloadDocument(data.storage_path)).buffer;
    } catch {
      return NextResponse.json({ error: "Document unavailable in storage" }, { status: 404 });
    }
  } else if (data.file_base64) {
    buf = Buffer.from(data.file_base64, "base64");
  } else {
    return NextResponse.json({ error: "Document not downloaded" }, { status: 404 });
  }
  const download = req.nextUrl.searchParams.get("download") === "1";
  const safe = (data.filename || "document").replace(/[^a-z0-9._-]+/gi, "_");
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": data.content_type || "application/octet-stream",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${safe}"`,
      "Content-Length": String(buf.length),
      "Cache-Control": "private, max-age=3600",
    },
  });
}
