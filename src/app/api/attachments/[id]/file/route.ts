import { NextRequest, NextResponse } from "next/server";
import { getServiceClient, dbConfigured } from "@/lib/supabase/server";
import { downloadDocument } from "@/lib/storage";
import { requireRole, AuthError } from "@/lib/auth/guard";

export const runtime = "nodejs";

/** GET /api/attachments/:id/file[?download=1] — serve a stored document for preview/download.
 *  Bytes come from Supabase Storage; legacy base64 rows are still served if present. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // API routes bypass the layout gate, so they must check for a
  // procurement account themselves.
  try { await requireRole("viewer"); }
  catch (e) { return Response.json({ error: e instanceof AuthError ? e.message : "forbidden" }, { status: 403 }); }

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
  const safe = (data.filename || "document").replace(/[^a-z0-9._-]+/gi, "_");

  // The Content-Type is decided HERE, from the filename extension — never taken
  // from data.content_type, which comes from a remote procurement portal (or an
  // uploader) and is therefore attacker-controlled. Echoing it back with
  // "inline" on this origin meant a crawled .html attachment executed with the
  // viewer's session — and this origin also serves payroll.
  const EXT_TYPES: Record<string, { type: string; inline: boolean }> = {
    pdf:  { type: "application/pdf", inline: true },
    png:  { type: "image/png", inline: true },
    jpg:  { type: "image/jpeg", inline: true },
    jpeg: { type: "image/jpeg", inline: true },
    gif:  { type: "image/gif", inline: true },
    webp: { type: "image/webp", inline: true },
    txt:  { type: "text/plain; charset=utf-8", inline: true },
    csv:  { type: "text/csv", inline: false },
    xlsx: { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", inline: false },
    xls:  { type: "application/vnd.ms-excel", inline: false },
    docx: { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", inline: false },
    doc:  { type: "application/msword", inline: false },
    zip:  { type: "application/zip", inline: false },
  };
  const ext = safe.includes(".") ? safe.split(".").pop()!.toLowerCase() : "";
  const chosen = EXT_TYPES[ext];
  // Unknown/absent extension: opaque bytes, forced download. Never guessed.
  const contentType = chosen?.type ?? "application/octet-stream";
  const forceDownload = req.nextUrl.searchParams.get("download") === "1" || !chosen?.inline;

  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `${forceDownload ? "attachment" : "inline"}; filename="${safe}"`,
      "Content-Length": String(buf.length),
      // Defence in depth: stop MIME sniffing and neutralise anything that
      // still manages to be interpreted as a document.
      "X-Content-Type-Options": "nosniff",
      // This handler is the SINGLE source of truth for this response's CSP —
      // next.config.ts must not set one for this path, because a config CSP is
      // applied before the handler runs and send-response.js then drops the
      // handler's CSP rather than merging it (see the note in next.config.ts).
      // `frame-ancestors 'self'` is what actually permits DocumentsPanel to
      // <iframe> this endpoint; browsers that honour it ignore X-Frame-Options
      // entirely, and older ones fall back to the SAMEORIGIN set in next.config.
      "Content-Security-Policy": "default-src 'none'; sandbox; frame-ancestors 'self'",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
