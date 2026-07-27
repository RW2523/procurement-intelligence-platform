/**
 * Tests for the document size/type gate that protects the box from an OOM
 * while parsing a hostile or oversized file.
 *
 *   npx tsx --conditions=react-server scripts/test-document-limits.mts
 *
 * (`--conditions=react-server` is needed because the parser half of the gate
 * imports "server-only", exactly as scripts/crawl.mts does.)
 *
 * The point of these tests is not "big files are refused" — it is WHERE they
 * are refused. Production is a 2 GB t4g.small shared with the payroll app: a
 * limit checked after the bytes are resident, or after pdf.js has been handed
 * the document, protects nothing. So the assertions below are mostly about
 * ORDER: which check fires first, and which code never runs as a result.
 */
import { readFileSync } from "fs";
import {
  MAX_FILE_BYTES,
  MAX_PARSED_TEXT_CHARS,
  MAX_PDF_PARSE_BYTES,
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_REQUEST_BYTES,
  checkUploadBatch,
  checkUploadFile,
  checkUploadRequestSize,
} from "../src/lib/documents/limits.ts";
import { checkUploadBytes, extractDocumentText, isPdf, sniffKind } from "../src/lib/documents/parse.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const rss = () => `${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`;

/**
 * A real, structurally valid PDF containing the text "GATE TEST", optionally
 * padded to an arbitrary size with an unreferenced filler stream.
 *
 * It has to be genuinely valid: the whole experiment below rests on the SAME
 * document parsing when it is small and being refused when it is large. A fake
 * PDF would fail to parse at both sizes and prove nothing.
 */
function buildPdf(fillerBytes = 0): Buffer {
  const objs: string[] = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objs[3] =
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R " +
    "/Resources << /Font << /F1 5 0 R >> >> >>";
  const content = "BT /F1 24 Tf 20 100 Td (GATE TEST) Tj ET\n";
  objs[4] = `<< /Length ${content.length} >>\nstream\n${content}endstream`;
  objs[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  if (fillerBytes > 0) {
    // Unreferenced object: pads the file without changing what it renders.
    objs[6] = `<< /Length ${fillerBytes} >>\nstream\n${"A".repeat(fillerBytes)}\nendstream`;
  }

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = Buffer.byteLength(out, "latin1");
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(out, "latin1");
  const size = objs.length;
  out += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let i = 1; i < size; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

console.log("\n── 1. Request-size gate: decided from a header, before any body is read ──");
{
  check(
    "rejects a 500 MB upload",
    checkUploadRequestSize(String(500 * 1024 * 1024))?.includes("limit is") === true,
    String(checkUploadRequestSize(String(500 * 1024 * 1024))),
  );
  check(
    "rejects one byte over the cap",
    checkUploadRequestSize(String(MAX_UPLOAD_REQUEST_BYTES + 1)) !== null,
  );
  check("accepts exactly the cap", checkUploadRequestSize(String(MAX_UPLOAD_REQUEST_BYTES)) === null);
  check("accepts a normal 2 MB upload", checkUploadRequestSize(String(2 * 1024 * 1024)) === null);
  check("tolerates a missing Content-Length", checkUploadRequestSize(null) === null);
  check("tolerates a junk Content-Length", checkUploadRequestSize("not-a-number") === null);
  const msg = checkUploadRequestSize(String(500 * 1024 * 1024)) ?? "";
  check("the message states both the actual size and the limit", msg.includes("500.0 MB") && msg.includes("32.0 MB"), msg);
}

console.log("\n── 2. Per-file gate: from File metadata, before arrayBuffer() ────────────");
{
  // No bytes exist here at all — only { name, size }, which is what FormData
  // exposes before the file is read. That is the whole point of this gate.
  const huge = { name: "hostile.pdf", size: 200 * 1024 * 1024 };
  check("rejects a 200 MB PDF from metadata alone", checkUploadFile(huge) !== null, String(checkUploadFile(huge)));
  check(
    "rejects one byte over the per-file cap",
    checkUploadFile({ name: "a.pdf", size: MAX_FILE_BYTES + 1 }) !== null,
  );
  check("accepts exactly the per-file cap", checkUploadFile({ name: "a.pdf", size: MAX_FILE_BYTES }) === null);
  check("rejects .exe", checkUploadFile({ name: "payload.exe", size: 10 }) !== null);
  check("rejects .html", checkUploadFile({ name: "page.html", size: 10 }) !== null);
  check("rejects .svg (executable in a browser)", checkUploadFile({ name: "x.svg", size: 10 }) !== null);
  check("rejects a file with no extension", checkUploadFile({ name: "README", size: 10 }) !== null);
  for (const ok of ["rfp.pdf", "Scope.DOCX", "sheet.xlsx", "notes.txt", "a.zip"]) {
    check(`accepts ${ok}`, checkUploadFile({ name: ok, size: 1024 }) === null);
  }
  check("the message names the offending file", checkUploadFile(huge)?.includes("hostile.pdf") === true);
}

console.log("\n── 3. Batch gate: the whole attachment set, before any of it is read ─────");
{
  const many = Array.from({ length: MAX_UPLOAD_FILES + 1 }, (_, i) => ({ name: `d${i}.pdf`, size: 1024 }));
  check(`rejects ${MAX_UPLOAD_FILES + 1} files`, checkUploadBatch(many) !== null, String(checkUploadBatch(many)));
  check(
    `accepts ${MAX_UPLOAD_FILES} files`,
    checkUploadBatch(many.slice(0, MAX_UPLOAD_FILES)) === null,
  );
  // Each file is individually legal (20 MB < 25 MB) but together they are not:
  // an upload holds every part in memory at once, so the total is what matters.
  const twoBig = [
    { name: "a.pdf", size: 20 * 1024 * 1024 },
    { name: "b.pdf", size: 20 * 1024 * 1024 },
  ];
  check("each file legal but the batch total is not → rejected", checkUploadBatch(twoBig) !== null, String(checkUploadBatch(twoBig)));
  check("empty batch is fine", checkUploadBatch([]) === null);
}

console.log("\n── 4. Content gate: magic bytes, after a size-bounded read ───────────────");
{
  const pdf = buildPdf();
  const html = Buffer.from("<!DOCTYPE html><html><body>Sign in to download</body></html>");
  check("a real PDF sniffs as pdf", sniffKind(pdf) === "pdf" && isPdf(pdf));
  check("an HTML login page saved as .docx is refused", checkUploadBytes(html, "scope.docx") !== null, String(checkUploadBytes(html, "scope.docx")));
  check("an HTML page saved as .pdf is refused", checkUploadBytes(html, "rfp.pdf") !== null);
  check("a .zip that is not a zip is allowed through (stored, never parsed)", checkUploadBytes(Buffer.from("plain"), "x.zip") === null);
  check("a genuine PDF passes", checkUploadBytes(pdf, "rfp.pdf") === null);
  check(
    "%PDF- after leading junk is still a PDF (readers tolerate it)",
    isPdf(Buffer.concat([Buffer.alloc(300, 0x20), pdf])),
  );
}

console.log("\n── 5. THE PARSE GATE — the defect this change exists to fix ──────────────");
{
  // CONTROL A: the document parses when it is small. Without this, every
  // "no text extracted" result below would be indistinguishable from a broken
  // parser, and the tests would prove nothing.
  const small = buildPdf();
  const t0 = Date.now();
  const okRes = await extractDocumentText(small, "application/pdf");
  console.log(`     (small PDF: ${small.length} bytes, parsed in ${Date.now() - t0} ms, rss ${rss()})`);
  check("small PDF IS parsed — pdf.js is reachable", okRes.text?.includes("GATE TEST") === true, JSON.stringify(okRes));
  check("small PDF records no skip reason", okRes.skipped === null);

  // CONTROL B: what a REAL parse failure looks like, so the message in the
  // oversize cases below can be attributed to the gate and not to pdf.js
  // simply choking on the input.
  const junkSmall = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(4096, 0x41)]);
  const junkRes = await extractDocumentText(junkSmall, "application/pdf");
  check("a small unreadable PDF reaches pdf.js and fails there", junkRes.text === null, JSON.stringify(junkRes));
  check(
    "…and its message is a PARSE failure, not a size refusal",
    !(junkRes.skipped ?? "").includes("text is only extracted below"),
    String(junkRes.skipped),
  );

  // THE TEST: the same valid document, padded past MAX_PDF_PARSE_BYTES.
  // Small → text. Large → no text, and the reason is the SIZE message, which
  // is only reachable on the branch that returns BEFORE getDocumentProxy() is
  // called. Different message = different code path = the gate fired first.
  const big = buildPdf(MAX_PDF_PARSE_BYTES + 1_000_000);
  check(`padded PDF really is over the cap (${(big.length / 1048576).toFixed(1)} MB)`, big.length > MAX_PDF_PARSE_BYTES);
  const before = process.memoryUsage().rss;
  const t1 = Date.now();
  const bigRes = await extractDocumentText(big, "application/pdf");
  const elapsed = Date.now() - t1;
  const grew = (process.memoryUsage().rss - before) / 1048576;
  console.log(`     (oversize PDF: ${big.length} bytes, returned in ${elapsed} ms, rss grew ${grew.toFixed(1)} MB)`);
  check("oversize PDF extracts NO text", bigRes.text === null, JSON.stringify(bigRes));
  check(
    "…and is refused by the SIZE gate, not by pdf.js",
    (bigRes.skipped ?? "").includes("text is only extracted below"),
    String(bigRes.skipped),
  );
  check(
    "…the reason names the real size and the cap",
    (bigRes.skipped ?? "").includes(`${(big.length / 1048576).toFixed(1)} MB`) &&
      (bigRes.skipped ?? "").includes("8.0 MB"),
    String(bigRes.skipped),
  );
  // pdf.js on ~10 MB takes hundreds of ms and allocates several times the
  // input. Returning in single-digit ms is only possible if it never ran.
  check(`…and returns without invoking the parser (${elapsed} ms)`, elapsed < 100, `${elapsed} ms`);

  // The gate must not be dodgeable by lying about the content type: a PDF
  // labelled text/plain still takes the PDF branch, because magic bytes decide.
  const lied = await extractDocumentText(big, "text/plain");
  check(
    "an oversize PDF mislabelled text/plain is still caught",
    lied.text === null && (lied.skipped ?? "").includes("text is only extracted below"),
    JSON.stringify(lied),
  );

  // And a PDF served as application/octet-stream (portals do this constantly)
  // must still be recognised and parsed.
  const octet = await extractDocumentText(small, "application/octet-stream");
  check("a small PDF served as octet-stream is still parsed", octet.text?.includes("GATE TEST") === true);
}

console.log("\n── 6. Text decoding is bounded too ──────────────────────────────────────");
{
  // 5 MB of text: the old code did buffer.toString("utf8") on the whole thing
  // (a ~10 MB string) only to keep the first 60 000 chars.
  const bigText = Buffer.alloc(5 * 1024 * 1024, 0x61); // "aaaa…"
  const res = await extractDocumentText(bigText, "text/plain; charset=utf-8");
  check("text is extracted", res.text !== null);
  check(
    `text is capped at ${MAX_PARSED_TEXT_CHARS} chars`,
    (res.text ?? "").length === MAX_PARSED_TEXT_CHARS,
    String((res.text ?? "").length),
  );
  const office = await extractDocumentText(Buffer.from("PKrest"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  check("Office documents are stored, never handed to a parser", office.text === null && office.skipped === null);
}

console.log("\n── 7. Call ORDER in the upload route (the actual defect was ordering) ────");
{
  // A unit test cannot observe that the route checked the size before it
  // buffered the body — but the source can. These assertions fail loudly if
  // someone later moves a gate after the allocation it is supposed to guard,
  // which is precisely how the upload path lost its cap in the first place.
  const route = readFileSync(new URL("../src/app/api/bids/route.ts", import.meta.url), "utf8");
  const at = (needle: string) => route.indexOf(needle);
  check("route checks Content-Length before req.formData()", at("checkUploadRequestSize") < at("req.formData()") && at("checkUploadRequestSize") !== -1);
  check("route validates the batch before f.arrayBuffer()", at("checkUploadBatch") < at("arrayBuffer()") && at("checkUploadBatch") !== -1);
  check("route validates files before inserting the opportunity", at("checkUploadBatch") < at(".insert("));
  check("route returns 413 for an oversize upload", route.includes("status: 413"));
  check("route no longer silently truncates the file list", !route.includes("files.slice(0, 12)"));

  const att = readFileSync(new URL("../src/lib/crawl/attachments.ts", import.meta.url), "utf8");
  check("crawl path defines no private limit constants", !/const MAX_[A-Z_]+ =/.test(att), "a limit was re-declared locally");
  check("crawl path parses only through the shared gate", att.includes("extractDocumentText") && !att.includes("getDocumentProxy"));
  check("upload path parses only through the shared gate", !route.includes("getDocumentProxy"));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
