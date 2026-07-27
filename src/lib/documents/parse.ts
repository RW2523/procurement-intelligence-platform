import "server-only";
import { extractText, getDocumentProxy } from "unpdf";
import {
  MAX_PARSED_TEXT_CHARS,
  MAX_PDF_PARSE_BYTES,
  MAX_TEXT_DECODE_BYTES,
  extFromName,
  mb,
} from "./limits";

/**
 * The parser side of the document gate. Server-only: it pulls in unpdf/pdf.js,
 * which must never reach a client bundle. The numbers it enforces live in
 * ./limits.ts, which is isomorphic so the upload form can pre-check with the
 * same values.
 *
 * Every entry point that turns bytes into text goes through here — the crawler
 * (src/lib/crawl/attachments.ts) and the upload route
 * (src/app/api/bids/route.ts) both call extractDocumentText and nothing else.
 */

const EXT_CT: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  csv: "text/csv",
  rtf: "application/rtf",
  zip: "application/zip",
};

export function normalizeContentType(headerCT: string, filename: string): string {
  const ct = headerCT.split(";")[0].trim().toLowerCase();
  if (ct && ct !== "application/octet-stream" && ct !== "binary/octet-stream") return ct;
  return EXT_CT[extFromName(filename)] ?? "application/octet-stream";
}

/**
 * Identify a file from its magic bytes so neither path ever treats an HTML
 * login/error page as a "document" (the classic gated-download failure: a 200
 * carrying a redirect page), and so a PDF is recognised even when the portal
 * sends a generic content-type or the URL has no extension.
 */
export function sniffKind(buf: Buffer): "pdf" | "zip" | "ole" | "rtf" | "html" | "binary" {
  if (buf.length < 4) return "binary";
  if (isPdf(buf)) return "pdf";
  if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) return "zip"; // PK
  if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return "ole"; // legacy Office
  if (buf[0] === 0x7b && buf[1] === 0x5c && buf[2] === 0x72 && buf[3] === 0x74) return "rtf"; // {\rt
  const head = buf.subarray(0, 800).toString("latin1").trimStart().toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html") || (head.startsWith("<?xml") && head.includes("<html"))) return "html";
  if (head.startsWith("<") && head.includes("<body")) return "html";
  return "binary";
}

/**
 * True when the bytes really are a PDF. The spec puts %PDF- at offset 0, but
 * real files (and every major reader) tolerate leading junk, so the marker is
 * searched in the first 1 KB — testing offset 0 alone would reject PDFs that
 * open perfectly well in Acrobat.
 */
export function isPdf(buf: Buffer): boolean {
  return buf.subarray(0, 1024).indexOf("%PDF-", 0, "latin1") !== -1;
}

/**
 * Gate #3 — content, once a size-bounded read has happened. The extension got
 * the file this far; the magic bytes decide whether it is what it claims. Only
 * unambiguous mismatches are refused, because over-strict sniffing breaks real
 * documents (Word writes RTF into a .doc, portals wrap Office formats oddly).
 */
export function checkUploadBytes(buffer: Buffer, filename: string): string | null {
  const name = filename || "document";
  const ext = extFromName(name);
  const kind = sniffKind(buffer);
  if (kind === "html" && ext !== "txt" && ext !== "csv") {
    return `"${name}" is an HTML page, not a ${ext.toUpperCase()} document.`;
  }
  if (ext === "pdf" && kind !== "pdf") {
    return `"${name}" is not a readable PDF — its contents don't match the .pdf extension.`;
  }
  return null;
}

export interface ExtractResult {
  /** Extracted text, capped at MAX_PARSED_TEXT_CHARS. Null when none was taken. */
  text: string | null;
  /**
   * Why no text was extracted, when that is worth recording against the
   * attachment (a refused or failed parse, not merely an unsupported format).
   * Null when text was extracted, or when the format has no extractor at all.
   */
  skipped: string | null;
}

/**
 * The ONLY place a document's bytes are handed to a parser.
 *
 * Crawl and upload both call this, so the parse gate cannot drift between them.
 * Nothing here allocates more than a bounded multiple of the input, and the
 * input is already bounded by MAX_FILE_BYTES.
 *
 * A refused or failed parse is never fatal: the bytes are still stored and the
 * document is still downloadable — only the AI's view of it is poorer.
 */
export async function extractDocumentText(
  buffer: Buffer,
  contentType: string,
): Promise<ExtractResult> {
  const ct = (contentType || "").toLowerCase();

  // PDF — decided by magic bytes as well as content-type, because portals serve
  // real PDFs as application/octet-stream all the time.
  if (ct.includes("pdf") || isPdf(buffer)) {
    // THE gate. Checked before getDocumentProxy() sees a single byte.
    if (buffer.length > MAX_PDF_PARSE_BYTES) {
      return {
        text: null,
        skipped: `PDF is ${mb(buffer.length)}; text is only extracted below ${mb(MAX_PDF_PARSE_BYTES)}. The file is stored and downloadable.`,
      };
    }
    try {
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const { text } = await extractText(pdf, { mergePages: true });
      const merged = Array.isArray(text) ? text.join("\n") : text;
      // Strips the NUL bytes pdf.js emits for unmapped glyphs — Postgres rejects
      // them outright ("unsupported Unicode escape sequence"). Written as an
      // escape rather than a literal NUL so the character survives an edit.
      const cleaned = (merged ?? "").replace(/\u0000/g, "").trim();
      return { text: cleaned ? cleaned.slice(0, MAX_PARSED_TEXT_CHARS) : null, skipped: null };
    } catch {
      return { text: null, skipped: "PDF could not be read (damaged, encrypted, or image-only)." };
    }
  }

  // Plain text / CSV — decode a bounded prefix, never the whole buffer.
  if (ct.startsWith("text/")) {
    const slice = buffer.subarray(0, MAX_TEXT_DECODE_BYTES);
    const text = slice.toString("utf8").replace(/\u0000/g, "").slice(0, MAX_PARSED_TEXT_CHARS).trim();
    return { text: text || null, skipped: null };
  }

  // Office and archives: stored, not parsed. No extractor is wired up, and
  // adding one (mammoth / SheetJS) would need its own gate before it runs —
  // both are zip-backed and expand far past their on-disk size.
  return { text: null, skipped: null };
}
