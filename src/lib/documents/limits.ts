/* ── ONE gate for every document that enters this app ─────────────────────────
 *
 * Two paths bring bytes in, and they used to police themselves independently:
 *
 *   crawl  → src/lib/crawl/attachments.ts  (downloadAttachment)
 *   upload → src/app/api/bids/route.ts     (storeUploadedDocument)
 *
 * The crawl path capped a PDF at 8 MB before handing it to pdf.js. The upload
 * path had no such cap, so a user-supplied PDF of any size up to the 25 MB
 * store limit went straight to the parser. That is the defect this module
 * exists to make impossible: both paths call the SAME functions, so a limit
 * cannot be tightened on one and forgotten on the other.
 *
 * Why it matters here specifically: production is a single 2 GB t4g.small
 * shared with the PAYROLL app behind one Caddy. An OOM is not a failed request
 * — pm2 kills the process and payroll restarts with it. Every constant below is
 * a MEMORY bound, and every check sits BEFORE the allocation it guards.
 *
 * THIS FILE IS ISOMORPHIC ON PURPOSE. The upload form imports it to pre-check
 * files in the browser, so it must not import `server-only`, `unpdf`, or touch
 * Buffer. Everything that needs the actual bytes lives in ./parse.ts, which is
 * server-only. Policy here, parser there — one set of numbers for both.
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Largest single document we will hold in memory or store.
 * Enforced on the crawl path by passing it to fetchBuffer as `maxBytes` (the
 * response body is refused mid-stream, so the bytes are never allocated), and
 * on the upload path by reading File.size BEFORE calling File.arrayBuffer().
 */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Largest multipart upload accepted in one request, checked against
 * Content-Length before `req.formData()` runs — formData() materialises every
 * part in memory, so a check after it is a check after the damage.
 *
 * Deliberately NOT 12 × MAX_FILE_BYTES: the crawler holds one document at a
 * time, but an upload holds all of its files at once, and briefly twice (once
 * in the proxy's cloned body, once in the parsed FormData). 32 MB caps the peak
 * near 64 MB, which this box can absorb.
 *
 * KEEP IN SYNC with `experimental.proxyClientMaxBodySize` in next.config.ts.
 * Next 16 buffers the request body in the proxy layer (src/proxy.ts matches
 * /api/bids) and silently TRUNCATES past that limit — if the proxy cap were the
 * lower of the two, a legitimate upload would arrive as a corrupt multipart
 * body and surface as an unexplained 400.
 */
export const MAX_UPLOAD_REQUEST_BYTES = 32 * 1024 * 1024;

/** Files accepted per upload. */
export const MAX_UPLOAD_FILES = 12;

/**
 * pdf.js expands a document several times over in memory — far worse for
 * scanned pages, and unbounded for deliberately malformed files (deep object
 * graphs, compression bombs), where the blow-up bears no relation to the input
 * size. Above this the file is STORED but not parsed. A document too big to
 * read is a feature loss; an OOM is an outage for two applications.
 */
export const MAX_PDF_PARSE_BYTES = 8 * 1024 * 1024;

/**
 * Bytes of a text/* document decoded to a JS string. `buffer.toString("utf8")`
 * on a 25 MB file allocates a ~50 MB string only to discard all but 60 000
 * chars of it; we decode a bounded prefix instead.
 */
export const MAX_TEXT_DECODE_BYTES = 2 * 1024 * 1024;

/** Extracted text stored per document (attachments.parsed_text). */
export const MAX_PARSED_TEXT_CHARS = 60_000;

/**
 * Upload type allowlist, by EXTENSION. The browser-supplied MIME type is
 * attacker-controlled and never decides this — it is only a hint for the stored
 * content_type. Kept in step with the `accept` list on the upload form.
 */
export const ALLOWED_UPLOAD_EXTENSIONS = [
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "rtf", "zip",
] as const;

const ALLOWED = new Set<string>(ALLOWED_UPLOAD_EXTENSIONS);

/** Human size for error copy: 9437184 → "9.0 MB". */
export function mb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function extFromName(name: string): string {
  const m = /\.([a-z0-9]{2,5})(?:$|\?)/i.exec(name);
  return m ? m[1].toLowerCase() : "";
}

/* ── Upload gates ─────────────────────────────────────────────────────────────
 * Each returns a message to show the user, or null when the input is fine.
 * Ordered by how early they can run: request size (a header, before any body is
 * read) → per-file metadata (File.size, before arrayBuffer()) → bytes
 * (checkUploadBytes in ./parse.ts, after a bounded read).
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Gate #1 — the earliest check available in the request. Reads only the
 * Content-Length header, so a 500 MB post is refused before `formData()` pulls
 * it into memory.
 *
 * A missing header is not a rejection: browsers always send one for a FormData
 * body, and the proxy-layer cap (next.config.ts) bounds the pathological case
 * anyway. Refusing it would break nothing real and protect nothing real.
 */
export function checkUploadRequestSize(contentLength: string | null): string | null {
  const declared = Number(contentLength ?? "");
  if (!Number.isFinite(declared) || declared <= 0) return null;
  if (declared > MAX_UPLOAD_REQUEST_BYTES) {
    return `That upload is ${mb(declared)}. The limit is ${mb(MAX_UPLOAD_REQUEST_BYTES)} per submission — attach fewer documents, or add the large ones to the bid after saving it.`;
  }
  return null;
}

/**
 * Gate #2 — one file, from FormData metadata only. `File.size` is known without
 * touching the bytes, so this runs BEFORE `File.arrayBuffer()` makes a copy.
 */
export function checkUploadFile(file: { name: string; size: number }): string | null {
  const name = file.name || "document";
  const ext = extFromName(name);
  if (!ext || !ALLOWED.has(ext)) {
    return `"${name}" is not a supported document type. Allowed: ${ALLOWED_UPLOAD_EXTENSIONS.join(", ")}.`;
  }
  if (file.size > MAX_FILE_BYTES) {
    return `"${name}" is ${mb(file.size)}. The limit is ${mb(MAX_FILE_BYTES)} per document.`;
  }
  return null;
}

/**
 * Gate #2b — the whole attachment set, checked together before ANY of it is
 * read. Catches the case where each file passes but the batch does not.
 */
export function checkUploadBatch(files: { name: string; size: number }[]): string | null {
  if (files.length > MAX_UPLOAD_FILES) {
    return `You attached ${files.length} documents. The limit is ${MAX_UPLOAD_FILES} per bid.`;
  }
  let total = 0;
  for (const f of files) {
    const bad = checkUploadFile(f);
    if (bad) return bad;
    total += f.size;
  }
  if (total > MAX_UPLOAD_REQUEST_BYTES) {
    return `Those ${files.length} documents total ${mb(total)}. The limit is ${mb(MAX_UPLOAD_REQUEST_BYTES)} per submission.`;
  }
  return null;
}
