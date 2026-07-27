/**
 * Pipeline_2026 workbook reader and row mapper — THE ONE MAPPING LAYER.
 *
 * Both the CLI (scripts/import-pipeline-xlsx.mts) and the in-app upload
 * (src/app/api/import/pipeline/route.ts) call mapWorkbook() from here. They must
 * never grow their own: this app has already been bitten twice by a second copy
 * of a mapper drifting from the first (the importer once carried its own
 * department table, which classified rows differently from the real matcher).
 *
 * PURE. No database, no "server-only", no filesystem — it takes bytes and
 * returns mapped rows plus a list of everything it could not map confidently.
 * That is what lets the same code run under `npx tsx` with no DATABASE_URL and
 * inside a request handler.
 *
 * The .xlsx reader is hand-rolled (ZIP inflate + the slice of SpreadsheetML that
 * carries values) so neither path needs a spreadsheet dependency.
 *
 * ── CONCURRENCY, read before editing ─────────────────────────────────────────
 * `issues` and `DATE_1904` are module-level mutable state, reset by
 * mapWorkbook() on entry. That is safe ONLY because the whole mapping path is
 * SYNCHRONOUS: Node runs it to completion before any other request can touch
 * these bindings. Introducing an `await` anywhere between the reset and the
 * return would let two concurrent uploads interleave and cross-contaminate each
 * other's warnings. If you need async work, do it BEFORE the map or AFTER it,
 * never inside.
 */
import { inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  DEPARTMENTS as PRIORITY_DEPARTMENTS,
  matchDepartment,
  departmentForOpportunity,
} from "@/lib/departments";

// ═══════════════════════════════════════════════════════════════════════════
// 1. XLSX reader — ZIP + the slice of SpreadsheetML that actually carries values
// ═══════════════════════════════════════════════════════════════════════════

type Cell = string | number | boolean | null;

/** Read a ZIP central directory. No ZIP64 (a 350 KB workbook never needs it). */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65_536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`workbook: no ZIP end-of-central-directory record — not an .xlsx?`);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (off === 0xffffffff) throw new Error("ZIP64 archive — unsupported by this reader");
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("corrupt ZIP central directory");
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const localHeader = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    // The local header's own name/extra lengths can differ from the central
    // directory's, so they must be re-read rather than reused.
    const lNameLen = buf.readUInt16LE(localHeader + 26);
    const lExtraLen = buf.readUInt16LE(localHeader + 28);
    const start = localHeader + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    out.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

const XML_ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decodeXml = (s: string) =>
  s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(parseInt(e[1] === "x" || e[1] === "X" ? e.slice(2) : e.slice(1), e[1] === "x" || e[1] === "X" ? 16 : 10));
    return XML_ENT[e] ?? m;
  });

const attr = (tag: string, name: string): string | null => {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? decodeXml(m[1]) : null;
};

/** Concatenate every <t> in a shared-string <si>, dropping phonetic <rPh> runs. */
function siText(inner: string): string {
  let s = "";
  const re = /<t\b[^>]*\/>|<t\b[^>]*>([\s\S]*?)<\/t>/g;
  const cleaned = inner.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned))) s += decodeXml(m[1] ?? "");
  return s;
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const re = /<si\b[^>]*\/>|<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(siText(m[1] ?? ""));
  return out;
}

/** "BC12" → 54 (0-based column index). */
function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/** Sheet XML → a dense 0-based grid. Missing cells are null. */
function parseSheet(xml: string, shared: string[]): Cell[][] {
  const grid: Cell[][] = [];
  const rowRe = /<row\b([^>]*)\/>|<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let r: RegExpExecArray | null;
  while ((r = rowRe.exec(xml))) {
    const rowAttrs = r[1] ?? r[2] ?? "";
    const body = r[3] ?? "";
    const rowNo = Number(attr(`<row ${rowAttrs}>`, "r") ?? grid.length + 1);
    const row: Cell[] = [];
    const cellRe = /<c\b([^>]*)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let c: RegExpExecArray | null;
    let auto = 0;
    while ((c = cellRe.exec(body))) {
      const attrs = `<c ${c[1] ?? c[2] ?? ""}>`;
      const inner = c[3] ?? "";
      const ref = attr(attrs, "r");
      const idx = ref ? colIndex(ref) : auto;
      auto = idx + 1;
      const t = attr(attrs, "t");
      let value: Cell = null;
      if (t === "inlineStr") {
        const is = inner.match(/<is\b[^>]*>([\s\S]*?)<\/is>/);
        value = is ? siText(is[1]) : null;
      } else {
        const v = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
        const raw = v ? decodeXml(v[1]) : null;
        if (raw === null) value = null;
        else if (t === "s") value = shared[Number(raw)] ?? null;
        else if (t === "str") value = raw;
        else if (t === "b") value = raw === "1";
        else if (t === "e") value = null; // #REF!/#N/A — treat as empty
        else value = raw === "" ? null : Number(raw);
      }
      row[idx] = value;
    }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = null;
    grid[rowNo - 1] = row;
  }
  for (let i = 0; i < grid.length; i++) if (!grid[i]) grid[i] = [];
  return grid;
}

interface Workbook { sheets: { name: string; grid: Cell[][] }[]; date1904: boolean }

/** Exported so the reader can be diffed against a reference parser. */
export function readWorkbook(buf: Buffer, path = "workbook"): Workbook {
  const zip = unzip(buf);
  const txt = (n: string) => { const b = zip.get(n); return b ? b.toString("utf8") : null; };
  const wbXml = txt("xl/workbook.xml");
  if (!wbXml) throw new Error(`${path}: no xl/workbook.xml — not an .xlsx?`);
  const date1904 = /<workbookPr\b[^>]*date1904="(1|true)"/.test(wbXml);

  // sheet name → rel id → part name
  const rels = new Map<string, string>();
  const relXml = txt("xl/_rels/workbook.xml.rels") ?? "";
  for (const m of relXml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const tag = `<r ${m[1]}>`;
    const id = attr(tag, "Id"); let target = attr(tag, "Target");
    if (!id || !target) continue;
    target = target.replace(/^\/?xl\//, "").replace(/^\.\//, "");
    rels.set(id, `xl/${target}`);
  }

  const shared = parseSharedStrings(txt("xl/sharedStrings.xml") ?? "");
  const sheets: Workbook["sheets"] = [];
  for (const m of wbXml.matchAll(/<sheet\b([^>]*)\/>/g)) {
    const tag = `<s ${m[1]}>`;
    const name = attr(tag, "name") ?? `Sheet${sheets.length + 1}`;
    const rid = attr(tag, "r:id") ?? attr(tag, "id");
    const part = (rid && rels.get(rid)) || `xl/worksheets/sheet${sheets.length + 1}.xml`;
    const sx = txt(part);
    sheets.push({ name, grid: sx ? parseSheet(sx, shared) : [] });
  }
  return { sheets, date1904 };
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Header location + fuzzy column mapping
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The brief said "headers in row 1" for BOTH sheets. That is TRUE for Pipeline
 * and FALSE for "Forecased Opportunities", whose row 1 is blank and whose
 * headers are in row 2 (0-based). Rather than hard-code either, find the row in
 * the first 10 that matches the most expected header names. Matching is on a
 * normalized key (lowercase, alphanumerics only) so the user's typos in the
 * header text itself — "Contract Vechicle", "Cature Stage" — do not have to be
 * spelled correctly here either; each canonical field carries its own aliases.
 */
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

const PIPE_FIELDS: Record<string, string[]> = {
  share:       ["sharenoshare", "share"],
  dateFound:   ["datefound"],
  agencyPoc:   ["agencypoc", "agency"],
  vehicle:     ["contractvechicle", "contractvehicle"],
  rfx:         ["rfx", "rfxnumber", "rfx#", "solicitationnumber"],
  website:     ["website", "link", "url"],
  description: ["description"],
  naics:       ["naicscode", "naics"],
  pop:         ["periodofperformance", "pop"],
  value:       ["estimatedvalue", "value"],
  setAside:    ["setaside", "setasides"],
  stage:       ["caturestage", "capturestage", "stage"],
  captureNote: ["status"],
  questions:   ["questionsdue", "questiondue", "qadue"],
  dueDate:     ["duedate", "due"],
  outcome:     ["wonloss", "wonlost", "winloss"],
  lessons:     ["lessonslearned", "lessons"],
};

const FCST_FIELDS: Record<string, string[]> = {
  dateFound:    ["datefound"],
  department:   ["agency", "department"],
  organization: ["organization", "suborganization"],
  title:        ["title"],
  link:         ["linktodetails", "link", "url", "website"],
  solicitation: ["estimatedsolicitationdate", "solicitationdate"],
  setAside:     ["setaside", "setasides"],
};

function locateHeader(grid: Cell[][], fields: Record<string, string[]>) {
  let best = { row: -1, hits: 0, map: {} as Record<string, number> };
  for (let r = 0; r < Math.min(10, grid.length); r++) {
    const map: Record<string, number> = {};
    let hits = 0;
    for (let c = 0; c < (grid[r]?.length ?? 0); c++) {
      const key = norm(grid[r][c]);
      if (!key) continue;
      for (const [field, aliases] of Object.entries(fields)) {
        if (map[field] !== undefined) continue;
        if (aliases.includes(key)) { map[field] = c; hits++; break; }
      }
    }
    if (hits > best.hits) best = { row: r, hits, map };
  }
  return best;
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Dates — Excel serials, US text dates, and named US time zones
// ═══════════════════════════════════════════════════════════════════════════

/** Offset (ms) of an IANA zone at a given UTC instant. Node ships full ICU. */
function zoneOffset(tz: string, ts: number): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(ts).map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - ts;
}

/** Wall-clock components in `tz` → the UTC instant. Two passes settle DST. */
function wallToUtc(y: number, mo: number, d: number, hh: number, mi: number, tz: string): Date {
  const naive = Date.UTC(y, mo - 1, d, hh, mi);
  let ts = naive;
  for (let i = 0; i < 2; i++) ts = naive - zoneOffset(tz, ts);
  return new Date(ts);
}

/**
 * Zone abbreviations → IANA zones. Mapping to a ZONE rather than a fixed offset
 * is deliberate: the sheet says "3/23/2026 2 PM CST" for a date that is actually
 * in CDT. Trusting the abbreviation's offset (-6) would land an hour off the
 * portal's real deadline; trusting the zone lets the DST rules decide, and the
 * verbatim cell is always kept in due_date_text so a bad call is recoverable.
 */
const ZONES: Record<string, string> = {
  et: "America/New_York", est: "America/New_York", edt: "America/New_York",
  easterntime: "America/New_York", easternstandardtime: "America/New_York",
  easterndaylighttime: "America/New_York",
  ct: "America/Chicago", cst: "America/Chicago", cdt: "America/Chicago",
  centraltime: "America/Chicago",
  mt: "America/Denver", mst: "America/Denver", mdt: "America/Denver",
  pt: "America/Los_Angeles", pst: "America/Los_Angeles", pdt: "America/Los_Angeles",
};
const DEFAULT_TZ = "America/New_York";

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

interface Cand { y: number; mo: number; d: number; hh: number | null; mi: number; tz: string; src: string }

const validYmd = (y: number, mo: number, d: number) =>
  mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2099;

/** Look just past a date match for a time-of-day and a zone. */
function timeAfter(text: string, from: number): { hh: number; mi: number; tz: string | null } | null {
  const tail = text.slice(from, from + 60);
  let hh: number | null = null, mi = 0;
  // Filler between the date and its time: "3/27/2026 before 5:00:00 PM",
  // "June 1, 2026, at 12:00 PM ET". Without these the time is missed and the
  // deadline silently becomes end-of-day.
  const FILL = String.raw`[\s,@]*(?:at|by|before|until|due(?:\s+by)?|n[o']?t?\s*later\s+than)?[\s,@]*`;
  const ampm = tail.match(new RegExp(`^${FILL}(\\d{1,2})(?::(\\d{2}))?(?::\\d{2})?\\s*([ap])\\.?\\s?m\\.?`, "i"));
  const h24 = tail.match(new RegExp(`^${FILL}(\\d{1,2}):(\\d{2})(?::\\d{2})?`));
  if (ampm) {
    hh = Number(ampm[1]) % 12; mi = Number(ampm[2] ?? 0);
    if (ampm[3].toLowerCase() === "p") hh += 12;
  } else if (h24) {
    hh = Number(h24[1]); mi = Number(h24[2]);
  }
  if (hh === null || hh > 23 || mi > 59) return null;
  const zoneWindow = tail.slice(0, 60);
  const z = zoneWindow.match(/\b(E|C|M|P)(?:S|D)?T\b|\b(Eastern|Central|Mountain|Pacific)\s+(?:Standard\s+|Daylight\s+)?Time\b/i);
  let tz: string | null = null;
  if (z) tz = ZONES[norm(z[0])] ?? null;
  return { hh, mi, tz };
}

/** Every date this cell mentions. Rejects "2/825/2026" and bare weekday names. */
function dateCandidates(text: string): Cand[] {
  const out: Cand[] = [];
  const push = (y: number, mo: number, d: number, end: number, src: string) => {
    if (!validYmd(y, mo, d)) return;
    const t = timeAfter(text, end);
    out.push({ y, mo, d, hh: t ? t.hh : null, mi: t ? t.mi : 0, tz: t?.tz ?? DEFAULT_TZ, src });
  };
  for (const m of text.matchAll(/(?<![\d\/-])(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})(?![\d\/-])/g)) {
    const y = Number(m[3]);
    push(y < 100 ? 2000 + y : y, Number(m[1]), Number(m[2]), m.index! + m[0].length, m[0]);
  }
  for (const m of text.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})\b/g)) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) push(Number(m[3]), mo, Number(m[2]), m.index! + m[0].length, m[0]);
  }
  for (const m of text.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?\s*,?\s*(\d{4})\b/g)) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo) push(Number(m[3]), mo, Number(m[1]), m.index! + m[0].length, m[0]);
  }
  return out;
}

let DATE_1904 = false;
/** Excel serial → WALL-CLOCK components (a serial carries no time zone). */
function serialWall(serial: number) {
  const base = DATE_1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const dt = new Date(base + Math.round(serial * 86_400_000));
  return {
    y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate(),
    hh: dt.getUTCHours(), mi: dt.getUTCMinutes(),
    hasTime: Math.abs(serial - Math.round(serial)) > 1e-9,
  };
}
/** Serials this workbook could plausibly mean as dates: 1970-01-01 … 2099. */
const isSerialDate = (v: unknown): v is number =>
  typeof v === "number" && v > 25_000 && v < 73_100;

const iso = (d: Date) => d.toISOString();
const isoDay = (y: number, mo: number, d: number) =>
  `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

type DateParse =
  | { kind: "empty" }
  | { kind: "ok"; value: string; note?: string }
  | { kind: "ambiguous"; reason: string }
  | { kind: "unparseable"; reason: string };

/**
 * A DEADLINE cell → timestamptz. The verbatim cell always survives in the
 * paired *_text column, so the only question here is whether the typed column
 * may be trusted.
 *   • one date            → parse it
 *   • several, same day   → parse the most specific (the one carrying a time)
 *   • several, DIFFERENT  → REFUSE. Sheet row 4's cell holds the due date AND a
 *     Q&A note; sheet row 53's holds an original date AND its extension, in the
 *     OPPOSITE order. No rule picks correctly for both, so neither is guessed.
 */
function parseDeadline(raw: Cell): DateParse {
  if (raw === null || raw === undefined) return { kind: "empty" };
  if (typeof raw === "number") {
    if (!isSerialDate(raw)) return { kind: "unparseable", reason: `numeric cell ${raw} is not a date serial` };
    const w = serialWall(raw);
    const hh = w.hasTime ? w.hh : 23, mi = w.hasTime ? w.mi : 59;
    return {
      kind: "ok",
      value: iso(wallToUtc(w.y, w.mo, w.d, hh, mi, DEFAULT_TZ)),
      note: w.hasTime ? undefined : "date-only serial → 23:59 America/New_York",
    };
  }
  const text = String(raw).replace(/\r\n?/g, "\n").trim();
  if (!text) return { kind: "empty" };
  const cands = dateCandidates(text);
  if (!cands.length) return { kind: "unparseable", reason: "no recognisable date in the cell" };
  const days = new Set(cands.map((c) => isoDay(c.y, c.mo, c.d)));
  if (days.size > 1) {
    return { kind: "ambiguous", reason: `${days.size} different dates in one cell (${[...days].join(", ")})` };
  }
  const pick = cands.find((c) => c.hh !== null) ?? cands[0];
  const hh = pick.hh ?? 23, mi = pick.hh === null ? 59 : pick.mi;
  const notes: string[] = [];
  if (pick.hh === null) notes.push("no time of day → 23:59 America/New_York");
  else if (cands.length > 1) notes.push("cell repeats the same date; took the mention that carries a time");
  if (/[?]{2,}/.test(text)) notes.push('cell contains "???" — the user was unsure');
  return { kind: "ok", value: iso(wallToUtc(pick.y, pick.mo, pick.d, hh, mi, pick.tz)), note: notes.join("; ") || undefined };
}

/** A "Date found" / forecast DATE cell → 'YYYY-MM-DD'. No time, no zone. */
function parseDay(raw: Cell): DateParse {
  if (raw === null || raw === undefined) return { kind: "empty" };
  if (typeof raw === "number") {
    if (!isSerialDate(raw)) return { kind: "unparseable", reason: `numeric cell ${raw} is not a date serial` };
    const w = serialWall(raw);
    return { kind: "ok", value: isoDay(w.y, w.mo, w.d) };
  }
  const text = String(raw).replace(/\r\n?/g, "\n").trim();
  if (!text) return { kind: "empty" };
  const cands = dateCandidates(text);
  if (!cands.length) return { kind: "unparseable", reason: `"${text}" is not a valid date` };
  const days = [...new Set(cands.map((c) => isoDay(c.y, c.mo, c.d)))];
  if (days.length > 1) return { kind: "ambiguous", reason: `${days.length} different dates (${days.join(", ")})` };
  return { kind: "ok", value: days[0] };
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Field-level parsers
// ═══════════════════════════════════════════════════════════════════════════

/** Normalise a cell to trimmed text with \n line endings. Blank → null. */
function text(raw: Cell): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).replace(/\r\n?/g, "\n").replace(/ /g, " ").trim();
  return s === "" ? null : s;
}

/** "Share/No Share": exactly Yes/No in this sheet, but blank in several rows. */
function parseShare(raw: Cell): { value: boolean; explicit: boolean } {
  const t = text(raw)?.toLowerCase();
  if (t === "yes" || t === "y" || t === "true") return { value: true, explicit: true };
  if (t === "no" || t === "n" || t === "false") return { value: false, explicit: true };
  return { value: false, explicit: false };
}

/** "Cature Stage" label → the 11-value vocabulary in src/lib/types.ts. */
const STAGES: Record<string, string> = {
  identified: "IDENTIFIED", qualifying: "QUALIFYING", pursuing: "PURSUING",
  nobid: "NO_BID", reviewing: "REVIEWING", approved: "APPROVED",
  submitted: "SUBMITTED", orals: "ORALS", bafo: "BAFO", won: "WON", lost: "LOST",
  // retired vocabulary, in case an older copy of the sheet is imported
  backlog: "IDENTIFIED", drafting: "PURSUING", declined: "NO_BID", awarded: "WON",
};
const DEFAULT_STAGE = "IDENTIFIED";

/**
 * "NAICS Code". Cells hold one code, two ("54151S & 518210C"), or a code plus
 * its name ("541511 Custom Computer Programming Services"). Also numeric cells
 * (541511 arrives as a JS number). 54151S / 518210C are GSA SINs, not NAICS,
 * but they are what the user tracks so they are kept verbatim.
 */
function parseNaics(raw: Cell): string[] {
  const t = text(raw);
  if (!t) return [];
  const out: string[] = [];
  for (const tok of t.split(/[\s,;&\/]+/)) {
    const c = tok.trim().toUpperCase();
    if (/^\d{4,6}[A-Z]?$/.test(c) && !out.includes(c)) out.push(c);
  }
  return out;
}

function parseSetAsides(raw: Cell): string[] {
  const t = text(raw);
  if (!t) return [];
  return [...new Set(t.split(/\s*[,;\/]\s*|\s+&\s+|\n+/).map((s) => s.trim()).filter(Boolean))];
}

/**
 * "Estimated Value". The only populated cell is "1.96B BPA" — free text with a
 * magnitude suffix. The numeric column is still populated (the dashboard sums it
 * and the targeting value bands compare it) but ONLY when a magnitude is
 * unambiguous; the verbatim cell always goes to estimated_value_text.
 */
function parseValue(raw: Cell): { num: number | null; note?: string } {
  if (typeof raw === "number") return { num: raw };
  const t = text(raw);
  if (!t) return { num: null };
  const m = t.match(/\$?\s*([\d,]+(?:\.\d+)?)\s*([KMB])?\b/i);
  if (!m) return { num: null, note: "no number in the cell" };
  const base = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(base)) return { num: null, note: "number did not parse" };
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase()] ?? 1;
  const num = base * mult;
  return { num, note: m[2] ? `"${t}" read as ${num.toLocaleString("en-US")}` : undefined };
}

/**
 * "RFx #" → external_id, half of the (source_id, external_id) unique key.
 *
 * No label dictionary: take the first LINE that contains an identifier-shaped
 * token (≥4 chars, contains a digit). That drops "Notice ID", "CR#:",
 * "Solicitation Number" and "BidNetdirect.com" without naming any of them.
 */
const DOCTYPE = /^(RF[PQIX]|BPA|BID|IFB|RFXP|SOL)$/i;
function parseExternalId(raw: Cell): { id: string | null; weak: boolean } {
  const t = text(raw);
  if (!t) return { id: null, weak: true };
  const lines = t.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const idish = (tok: string) => tok.length >= 4 && /\d/.test(tok) && /[A-Za-z0-9]/.test(tok);
  for (const line of lines) {
    const toks = line.split(/\s+/);
    const i = toks.findIndex((tk) => idish(tk.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")));
    if (i === -1) continue;
    const core = toks[i].replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
    // keep a leading RFP/RFQ/RFI word so "RFP 6052" does not collapse to "6052"
    let prefix = "";
    for (let j = i - 1; j >= 0 && j >= i - 2; j--) {
      const p = toks[j].replace(/[^A-Za-z]/g, "");
      if (!p) continue;
      if (DOCTYPE.test(p)) prefix = `${p} `;
      break;
    }
    return { id: (prefix + core).slice(0, 80), weak: false };
  }
  return { id: lines[0].slice(0, 80), weak: true };
}

/**
 * The sheet HAS NO TITLE COLUMN — opportunities.title is NOT NULL and the title
 * is the first line of "Description". A handful of cells are title-only.
 */
function splitTitle(desc: string | null): { title: string | null; body: string | null } {
  if (!desc) return { title: null, body: null };
  const lines = desc.split("\n");
  const firstIdx = lines.findIndex((l) => l.trim());
  if (firstIdx === -1) return { title: null, body: null };
  const first = lines[firstIdx].trim();
  const rest = lines.slice(firstIdx + 1).join("\n").trim() || null;
  if (first.length <= 200) return { title: first, body: rest };
  // one long unbroken paragraph: cut at the first sentence end inside 200 chars
  const dot = first.slice(0, 200).lastIndexOf(". ");
  if (dot > 40) return { title: first.slice(0, dot + 1).trim(), body: desc };
  return { title: `${first.slice(0, 197).trim()}…`, body: desc };
}

/** POC block → name / email / phone, best effort. */
function parsePoc(block: string | null) {
  if (!block) return { name: null, email: null, phone: null };
  const email = block.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.replace(/[.,;]$/, "") ?? null;
  const phone =
    block.match(/(?:\+1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/)?.[0]?.trim() ?? null;
  // A name line: 2-4 capitalised words, no digits, no @, not an org/label line.
  const LABEL = /\b(contact|agency|purchasing|procurement|contracts?|issuing|primary|point of contact|department|office|division|commission|administration|foundation|university|services|county|city|school|specialist|manager|director)\b/i;
  let name: string | null = null;
  for (const line of block.split("\n").map((l) => l.trim())) {
    if (!line || line.includes("@") || /\d/.test(line) || LABEL.test(line)) continue;
    if (/^([A-Z][A-Za-z'’.-]+)(\s+[A-Z][A-Za-z'’.-]+){1,3}$/.test(line)) { name = line; break; }
  }
  return { name, email, phone };
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Department / sub-agency / state matcher
// ═══════════════════════════════════════════════════════════════════════════

/**
 * THE FIVE PRIORITY DEPARTMENTS ARE NOT MATCHED HERE. They are matched by
 * src/lib/departments.ts, imported at the top of this file — the same module the
 * crawl pipeline (src/lib/crawl/pipeline.ts), the rescore route and the bids
 * route use, and the one deploy/db/schema.sql points `department` at.
 *
 * THIS FILE USED TO CARRY ITS OWN COPY, and the copy is what shipped the bugs
 * that module exists to prevent: a bare /\bDOT\b/ filed "Virginia DOT" and
 * "Mn/DOT" as the federal department; /\b…|CMS|…\b/ filed a Content Management
 * System under HHS; NPS filed a Net Promoter Score under DOI; FTA filed a Free
 * Trade Agreement under DOT; EIA filed an Environmental Impact Assessment under
 * DOE; and none of them knew "U.S. Dept. of Transportation" or "Health & Human
 * Services" at all, so the two commonest hand-typed spellings resolved to null.
 * The user TYPES THESE ROWS IN BY HAND — informal spellings are the norm — and
 * this importer is the ONE path that loads their real workbook. Two matchers
 * means the sheet gets the unguarded one. Do not reintroduce a second table.
 *
 * WHAT REMAINS BELOW is only the NON-PRIORITY codes, which the library
 * deliberately does not model: it answers null for everything outside the five,
 * because those five are a filter and a scoring bonus, NEVER a gate. This sheet
 * alone also carries DOJ, GSA, USDA, HUD, DOD, DOL, ED, NSF, FEC, CBO, ABMC,
 * USAGM, FTC — `department` has no CHECK constraint for exactly this reason —
 * and dropping them would blank out 21 of the 71 rows.
 */
interface Dept { code: string; name: string; aliases: RegExp[] }
const OTHER_DEPARTMENTS: Dept[] = [
  { code: "DOD", name: "Department of Defense", aliases: [
    /\bdepartment of (the )?(defense|army|navy|air force)\b/i, /\bDOD\b/, /\bDHA\b/,
    /\b(USACE|USMC|AFGSC|SSC)\b/, /corps of engineers/i, /marine corps/i, /space ?force/i,
    /defense health agency/i, /@(mail\.)?mil\b/i, /\.mil\b/i ] },
  { code: "DOJ", name: "Department of Justice", aliases: [
    /\bdepartment of justice\b/i, /\bDOJ\b/, /@usdoj\.gov\b/i, /federal prison industries/i, /\bFBI\b/, /\bBOP\b/ ] },
  { code: "DOL", name: "Department of Labor", aliases: [
    /\bdepartment of labor\b/i, /\bDOL\b/, /@dol\.gov\b/i, /\bOASAM\b/, /\bETA\b/ ] },
  { code: "ED", name: "Department of Education", aliases: [
    /\bdepartment of ed(ucation)?\b/i, /@ed\.gov\b/i ] },
  { code: "HUD", name: "Department of Housing and Urban Development", aliases: [
    /\bhousing and urban development\b/i, /\bHUD\b/, /@hud\.gov\b/i ] },
  { code: "USDA", name: "Department of Agriculture", aliases: [
    /\bdepartment of agriculture\b/i, /\bUSDA\b/, /\bFSIS\b/, /@usda\.gov\b/i ] },
  { code: "DHS", name: "Department of Homeland Security", aliases: [
    /\bhomeland security\b/i, /\bDHS\b/, /\b(CBP|FEMA|TSA|USCIS)\b/, /@(dhs|fema)\.gov\b/i ] },
  { code: "STATE", name: "Department of State", aliases: [/\bdepartment of state\b/i, /@state\.gov\b/i] },
  { code: "TREAS", name: "Department of the Treasury", aliases: [/\bdepartment of the treasury\b/i, /\bIRS\b/, /@irs\.gov\b/i] },
  { code: "NSF", name: "National Science Foundation", aliases: [/national science foundation/i, /\bNSF\b/, /@nsf\.gov\b/i] },
  { code: "FEC", name: "Federal Election Commission", aliases: [/federal election commission/i, /\bFEC\b/, /@fec\.gov\b/i] },
  { code: "FTC", name: "Federal Trade Commission", aliases: [/federal trade commission/i, /\bFTC\b/, /@ftc\.gov\b/i] },
  { code: "CBO", name: "Congressional Budget Office", aliases: [/congressional budget office/i, /\bCBO\b/, /@cbo\.gov\b/i] },
  { code: "ABMC", name: "American Battle Monuments Commission", aliases: [/american battle monuments/i, /\bABMC\b/, /@abmc\.gov\b/i] },
  { code: "USAGM", name: "U.S. Agency for Global Media", aliases: [/agency for global media/i, /\bUSAGM\b/, /@usagm\.gov\b/i] },
  { code: "NIGC", name: "National Indian Gaming Commission", aliases: [/\bNIGC\b/, /indian gaming commission/i] },
  { code: "FMCS", name: "Federal Mediation and Conciliation Service", aliases: [/\bFMCS\b/, /mediation and conciliation/i] },
  { code: "USITC", name: "U.S. International Trade Commission", aliases: [/\bUSITC\b/, /international trade commission/i] },
  { code: "GCERC", name: "Gulf Coast Ecosystem Restoration Council", aliases: [/\bGCERC\b/, /gulf coast ecosystem/i] },
  // GSA is LAST on purpose: it is the contracting VEHICLE for most eBuy rows, so
  // it must only win when nothing more specific matched.
  { code: "GSA", name: "General Services Administration", aliases: [
    /general services administration/i, /\bGSA\b/, /@gsa\.gov\b/i, /public buildings service/i,
    /federal acquisition service/i ] },
];

const SUB_AGENCIES: { code: string; dept: string; re: RegExp }[] = [
  { code: "FAA", dept: "DOT", re: /\bFAA\b|federal aviation/i },
  { code: "FMCSA", dept: "DOT", re: /\bFMCSA\b|federal motor carrier/i },
  { code: "FHWA", dept: "DOT", re: /\bFHWA\b|federal highway/i },
  { code: "FTA", dept: "DOT", re: /\bFTA\b|federal transit/i },
  { code: "NHTSA", dept: "DOT", re: /\bNHTSA\b|highway traffic safety/i },
  { code: "IBC", dept: "DOI", re: /\bIBC\b|interior business center/i },
  { code: "BSEE", dept: "DOI", re: /\bBSEE\b/ },
  { code: "EIA", dept: "DOE", re: /\bEIA\b|energy information administration/i },
  { code: "VHA", dept: "VA", re: /\bVHA\b|veterans health administration/i },
  { code: "HRSA", dept: "HHS", re: /\bHRSA\b|health resources and services/i },
  { code: "NCHS", dept: "HHS", re: /\bNCHS\b|national center for health statistics/i },
  { code: "CDC", dept: "HHS", re: /\bCDC\b|@cdc\.gov/i },
  { code: "NIH", dept: "HHS", re: /\bNIH\b|national institutes of health/i },
  { code: "ACF", dept: "HHS", re: /\bACF\b|administration for children/i },
  { code: "ASFR", dept: "HHS", re: /\bASFR\b|assistant secretary for financial resources/i },
  { code: "USACE", dept: "DOD", re: /\bUSACE\b|corps of engineers/i },
  { code: "USMC", dept: "DOD", re: /\bUSMC\b|marine corps/i },
  { code: "USAF", dept: "DOD", re: /department of the air force|\bAFGSC\b/i },
  { code: "NAVY", dept: "DOD", re: /department of the navy/i },
  { code: "DHA", dept: "DOD", re: /\bDHA\b|defense health agency/i },
  { code: "FPI", dept: "DOJ", re: /federal prison industries|\bFPI\b/i },
  { code: "FSIS", dept: "USDA", re: /\bFSIS\b|food safety and inspection/i },
  { code: "PBS", dept: "GSA", re: /public buildings service|\bPBS\b/i },
  { code: "FAS", dept: "GSA", re: /federal acquisition service\b/i },
];

/** Non-priority departments only — the five are the library's job. */
const matchOtherDept = (s: string | null): Dept | null =>
  (s ? OTHER_DEPARTMENTS.find((d) => d.aliases.some((re) => re.test(s))) : null) ?? null;

/** code → canonical name, for the five the library owns. */
const PRIORITY_NAMES = new Map(PRIORITY_DEPARTMENTS.map((d) => [d.code as string, d.name]));

/** What resolveAgency() and the row mapper need: a code and a display name. */
interface DeptRef { code: string; name: string }
const priorityRef = (code: string | null): DeptRef | null =>
  code ? { code, name: PRIORITY_NAMES.get(code) ?? code } : null;

/**
 * `poc` first, `title` as the fallback — and that ORDER is load-bearing.
 *
 *  · Matching the DESCRIPTION would be wrong: sheet row 45's body says "DOE's
 *    expansive technology environment" but its POC is tbenne2@schools.nyc.gov —
 *    that DOE is the New York City Department of Education, not Energy.
 *  · Matching the POC alone would also be wrong: 10 rows have "Gsa Market
 *    Research" as the POC because GSA eBuy is the vehicle, while the real
 *    customer is named in the title ("DOI - Secure AI Assistant … - MRAS").
 *    So when the POC resolves to GSA, the title gets a say.
 *
 * The five priority codes come from src/lib/departments.ts and nowhere else.
 * The title fallback goes through departmentForOpportunity(), which matches the
 * POC block and the title TOGETHER on purpose: the POC block carries NEGATIVE
 * evidence the title lacks ("tbenne2@schools.nyc.gov" is what lets acceptDOE()
 * read row 45's "DOE" as the NYC Department of Education and decline it).
 *
 * PRECEDENCE, unchanged from the hand-rolled version it replaces:
 *   1. a priority department named in the POC block wins outright;
 *   2. otherwise a non-priority department named in the POC block wins — except
 *      GSA, which is the eBuy VEHICLE rather than the customer;
 *   3. otherwise the title speaks, priority five first, then non-priority;
 *   4. GSA last, so it only lands when nothing more specific did.
 */
export function resolveDepartment(poc: string | null, title: string | null) {
  const otherFromPoc = matchOtherDept(poc);
  const dept: DeptRef | null =
    priorityRef(matchDepartment(poc)) ??
    (otherFromPoc && otherFromPoc.code !== "GSA" ? otherFromPoc : null) ??
    priorityRef(departmentForOpportunity(poc, title)) ??
    matchOtherDept(title) ??
    otherFromPoc;
  if (!dept) return { dept: null as DeptRef | null, sub: null as string | null };
  // Sub-agency acronyms are only consulted once the PARENT department is
  // already settled, which is the same corroboration rule the library applies
  // to its own collision-prone acronyms (CMS, FTA, EIA, NPS…): a bare "FTA"
  // can never reach this line unless DOT was independently established.
  const hay = `${poc ?? ""}\n${title ?? ""}`;
  const sub = SUB_AGENCIES.find((s) => s.dept === dept.code && s.re.test(hay))?.code ?? null;
  return { dept, sub };
}

const STATE_NAMES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS",
  kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA",
  michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND",
  ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX",
  utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY", "district of columbia": "DC",
};
const STATE_CODES = new Set(Object.values(STATE_NAMES));

/**
 * USPS code for HAND-ENTERED rows only. The state filter reads sources.state and
 * the 'manual' source is seeded state = null, so without this every typed-in row
 * is invisible to it. Only derived when NO federal department matched: a mailing
 * address on a federal POC block ("MINOT AFB, ND") is the contracting officer's
 * desk, not the opportunity's state.
 */
function resolveState(poc: string | null): string | null {
  if (!poc) return null;
  let m = poc.match(/\b([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/);
  if (m && STATE_CODES.has(m[1])) return m[1];
  m = poc.match(/\b([A-Za-z][A-Za-z ]+?)\s*,?\s+\d{5}(?:-\d{4})?\b/);
  if (m && STATE_NAMES[m[1].trim().toLowerCase()]) return STATE_NAMES[m[1].trim().toLowerCase()];
  m = poc.match(/\b([A-Z]{2})\s*-\s*([A-Za-z ]+)\b/);
  if (m && STATE_CODES.has(m[1]) && STATE_NAMES[m[2].trim().toLowerCase()] === m[1]) return m[1];
  m = poc.match(/United States\s*,\s*([A-Za-z ]+?)\s*(?:,|$)/i);
  if (m && STATE_NAMES[m[1].trim().toLowerCase()]) return STATE_NAMES[m[1].trim().toLowerCase()];
  m = poc.match(/@(?:[a-z0-9.-]*\.)?state\.([a-z]{2})\.us\b/i) ?? poc.match(/@[a-z0-9.-]*\b([a-z]{2})\.gov\b/i);
  if (m && STATE_CODES.has(m[1].toUpperCase())) return m[1].toUpperCase();
  for (const [name, code] of Object.entries(STATE_NAMES)) {
    if (new RegExp(`\\b${name}\\b`, "i").test(poc)) return code;
  }
  return null;
}

/**
 * `agency` must be a short ORGANISATION NAME, never the whole POC block: the
 * column is trigram-indexed, is one of the three ILIKE targets of the free-text
 * search, and is what the targeting engine matches agency aliases against. A
 * 279-char block containing "Albany, New York 12242" would match the New York
 * alias and pollute both scoring and search.
 */
const ORGISH = /\b(department|agency|administration|commission|authority|bureau|university|college|county|city of|district|foundation|office of|council|service|board|corporation|institute|ministry)\b/i;
function resolveAgency(poc: string | null, dept: DeptRef | null): string | null {
  if (poc) {
    const lines = poc.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 1 && lines[0].length <= 100) return lines[0];
    for (const line of lines) {
      if (line.length <= 120 && !line.includes("@") && ORGISH.test(line) && !/^\d/.test(line)) return line;
    }
  }
  return dept?.name ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Row mapping
// ═══════════════════════════════════════════════════════════════════════════

/** 1-based spreadsheet row number, the thing the user sees in Excel. */
const excelRow = (i: number) => i + 1;

interface Issue { row: number; level: "SKIP" | "WARN"; field: string; detail: string }
let issues: Issue[] = [];
const note = (row: number, level: Issue["level"], field: string, detail: string) =>
  issues.push({ row, level, field, detail });

interface MappedOpp {
  sheetRow: number;
  external_id: string;
  title: string;
  agency: string | null;
  naics_code: string | null;
  naics_codes: string[];
  description: string | null;
  due_date: string | null;
  q_and_a_deadline: string | null;
  estimated_value: number | null;
  detail_url: string | null;
  set_asides: string[];
  contract_vehicle: string | null;
  is_shared: boolean;
  date_found: string | null;
  department: string | null;
  sub_agency: string | null;
  state: string | null;
  poc_raw: string | null;
  poc_name: string | null;
  poc_email: string | null;
  poc_phone: string | null;
  rfx_number_raw: string | null;
  period_of_performance: string | null;
  estimated_value_text: string | null;
  q_and_a_deadline_text: string | null;
  due_date_text: string | null;
  capture_notes: string | null;
  outcome: string | null;
  lessons_learned: string | null;
  pipeline_stage: string;
  status: string;
  content_hash: string;
}

function mapPipelineRow(row: Cell[], col: Record<string, number>, r: number, seen: Set<string>): MappedOpp | null {
  const get = (f: string): Cell => (col[f] === undefined ? null : row[col[f]] ?? null);
  const rowNo = excelRow(r);

  const descRaw = text(get("description"));
  const { title, body } = splitTitle(descRaw);
  if (!title) {
    // opportunities.title is NOT NULL and the sheet has no Title column — the
    // title is the first line of Description. Without one there is no row.
    note(rowNo, "SKIP", "Description", "empty — title is the first line of Description and it is NOT NULL");
    return null;
  }

  // ── identity ──────────────────────────────────────────────────────────────
  const rfxRaw = text(get("rfx"));
  const parsed = parseExternalId(get("rfx"));
  let externalId = parsed.id;
  if (!externalId) {
    // Deterministic, and stable if rows move: a row-number key would not be.
    externalId = `XLSX-${createHash("sha1").update(title).digest("hex").slice(0, 10).toUpperCase()}`;
    note(rowNo, "WARN", "RFx #", `empty — external_id derived from the title hash (${externalId})`);
  } else if (parsed.weak) {
    note(rowNo, "WARN", "RFx #", `no identifier-shaped token; using the raw cell "${externalId}" as external_id`);
  }
  if (seen.has(externalId)) {
    // The sheet genuinely repeats RFQ1802837 and CR#: 2131174. The unique
    // constraint would reject the second, so it is suffixed by order of
    // appearance — deterministic, therefore still idempotent across runs.
    let n = 2;
    while (seen.has(`${externalId}-${n}`)) n++;
    note(rowNo, "WARN", "RFx #", `duplicate of an earlier row — imported as "${externalId}-${n}"`);
    externalId = `${externalId}-${n}`;
  }
  seen.add(externalId);

  // ── dates ─────────────────────────────────────────────────────────────────
  const df = parseDay(get("dateFound"));
  if (df.kind === "unparseable" || df.kind === "ambiguous") {
    note(rowNo, "WARN", "Date found", `${df.reason} — date_found left null (no raw-text column exists for it)`);
  }
  // The *_text columns exist to keep a MESSY cell recoverable. A clean Excel
  // date serial is not messy — echoing "46077.5" into due_date_text would be
  // noise on the pipeline grid — so the raw is kept only for text cells, and
  // for numeric cells only when the serial failed to parse.
  const rawText = (c: Cell, p: DateParse) =>
    typeof c === "number" ? (p.kind === "ok" ? null : String(c)) : text(c);

  const due = parseDeadline(get("dueDate"));
  const dueText = rawText(get("dueDate"), due);
  if (due.kind === "ambiguous") note(rowNo, "WARN", "Due Date", `${due.reason} — due_date left null, verbatim kept in due_date_text`);
  if (due.kind === "unparseable") note(rowNo, "WARN", "Due Date", `${due.reason} — verbatim kept in due_date_text`);
  if (due.kind === "ok" && due.note) note(rowNo, "WARN", "Due Date", due.note);

  const qa = parseDeadline(get("questions"));
  const qaText = rawText(get("questions"), qa);
  if (qa.kind === "ambiguous") note(rowNo, "WARN", "Questions Due:", `${qa.reason} — q_and_a_deadline left null, verbatim kept`);
  if (qa.kind === "unparseable") note(rowNo, "WARN", "Questions Due:", `${qa.reason} — verbatim kept`);
  if (qa.kind === "ok" && qa.note) note(rowNo, "WARN", "Questions Due:", qa.note);

  // ── stage / share ─────────────────────────────────────────────────────────
  const stageRaw = text(get("stage"));
  let stage = DEFAULT_STAGE;
  if (stageRaw) {
    const mapped = STAGES[norm(stageRaw)];
    if (mapped) stage = mapped;
    else note(rowNo, "WARN", "Cature Stage", `"${stageRaw}" is not one of the 11 stages — defaulted to ${DEFAULT_STAGE}`);
  } else {
    note(rowNo, "WARN", "Cature Stage", `empty — defaulted to ${DEFAULT_STAGE}`);
  }
  const share = parseShare(get("share"));
  if (!share.explicit) note(rowNo, "WARN", "Share/No Share", "empty — is_shared defaulted to false (NOT invented as true)");

  // ── agency / POC / department ─────────────────────────────────────────────
  const pocRaw = text(get("agencyPoc"));
  const { dept, sub } = resolveDepartment(pocRaw, title);
  const agency = resolveAgency(pocRaw, dept);
  if (!agency) note(rowNo, "WARN", "Agency/POC", "no organisation line could be identified — agency left null");
  const poc = parsePoc(pocRaw);
  const state = dept ? null : resolveState(pocRaw);

  // ── the rest ──────────────────────────────────────────────────────────────
  const naics = parseNaics(get("naics"));
  const rawNaics = text(get("naics"));
  if (rawNaics && naics.length === 0) note(rowNo, "WARN", "NAICS Code", `"${rawNaics}" held no code-shaped token`);
  if (naics.length > 1) note(rowNo, "WARN", "NAICS Code", `${naics.length} codes in one cell (${naics.join(", ")}) — naics_code = ${naics[0]}, all of them in naics_codes[]`);

  const val = parseValue(get("value"));
  if (val.note) note(rowNo, "WARN", "Estimated Value", val.note);

  const url = text(get("website"));
  // detail_url is plain text, so a non-URL breaks nothing at the DB layer — but
  // the UI must not render it as an <a href>: under basePath /procurement a
  // relative href resolves to a 404 inside the app.
  if (url && !/^https?:\/\//i.test(url)) note(rowNo, "WARN", "Website", `"${url}" is not a URL — stored, but do not render it as a link`);

  const dueIso = due.kind === "ok" ? due.value : null;
  const opp: MappedOpp = {
    sheetRow: rowNo,
    external_id: externalId,
    title,
    agency,
    naics_code: naics[0] ?? null,
    naics_codes: naics,
    description: body ?? descRaw,
    due_date: dueIso,
    q_and_a_deadline: qa.kind === "ok" ? qa.value : null,
    estimated_value: val.num,
    detail_url: url,
    set_asides: parseSetAsides(get("setAside")),
    contract_vehicle: text(get("vehicle")),
    is_shared: share.value,
    date_found: df.kind === "ok" ? df.value : null,
    department: dept?.code ?? null,
    sub_agency: sub,
    state,
    poc_raw: pocRaw,
    poc_name: poc.name,
    poc_email: poc.email,
    poc_phone: poc.phone,
    rfx_number_raw: rfxRaw,
    period_of_performance: text(get("pop")),
    estimated_value_text: text(get("value")),
    q_and_a_deadline_text: qaText,
    due_date_text: dueText,
    capture_notes: text(get("captureNote")),
    outcome: text(get("outcome")),
    lessons_learned: text(get("lessons")),
    pipeline_stage: stage,
    // The SOLICITATION's own lifecycle, a different axis from pipeline_stage.
    // Derived once, on INSERT only — never overwritten on re-import, because by
    // then the crawler or the app may own it.
    status: dueIso ? (Date.parse(dueIso) < Date.now() ? "CLOSED" : "OPEN") : "NEW",
    content_hash: "",
  };
  opp.content_hash = createHash("sha1")
    .update(JSON.stringify({ ...opp, sheetRow: undefined, content_hash: undefined }))
    .digest("hex");
  return opp;
}

interface MappedForecast {
  sheetRow: number;
  date_found: string | null;
  department: string | null;
  sub_agency: string | null;
  title: string;
  detail_url: string | null;
  estimated_solicitation_date: string | null;
  set_asides: string[];
}

function mapForecastRow(row: Cell[], col: Record<string, number>, r: number): MappedForecast | null {
  const get = (f: string): Cell => (col[f] === undefined ? null : row[col[f]] ?? null);
  const rowNo = excelRow(r);
  const title = text(get("title"));
  if (!title) { note(rowNo, "SKIP", "Title", "empty — forecast_opportunities.title is NOT NULL"); return null; }

  const df = parseDay(get("dateFound"));
  if (df.kind === "unparseable" || df.kind === "ambiguous") note(rowNo, "WARN", "Date Found", `${df.reason} — left null`);
  const sol = parseDay(get("solicitation"));
  if (sol.kind === "unparseable" || sol.kind === "ambiguous") note(rowNo, "WARN", "Estimated Solicitation Date", `${sol.reason} — left null`);

  // Two of the four "Link to details" cells carry a TRAILING SPACE, which would
  // defeat the partial unique index forecast_url_key on re-import.
  const url = text(get("link"));
  return {
    sheetRow: rowNo,
    date_found: df.kind === "ok" ? df.value : null,
    department: text(get("department")),
    sub_agency: text(get("organization")),
    title,
    detail_url: url,
    estimated_solicitation_date: sol.kind === "ok" ? sol.value : null,
    set_asides: parseSetAsides(get("setAside")),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Entry point — the only thing callers should need
// ═══════════════════════════════════════════════════════════════════════════

export interface MappedWorkbook {
  sheetNames: string[];
  date1904: boolean;
  pipeline: { sheet: string; headerRow: number; matched: number; total: number; missing: string[] } | null;
  forecast: { sheet: string; headerRow: number; matched: number; total: number } | null;
  opps: MappedOpp[];
  forecasts: MappedForecast[];
  issues: Issue[];
  rowsRead: number;
  blankRows: number;
  forecastRowsRead: number;
  error?: string;
}

/**
 * Read an .xlsx and map both sheets. Never throws for a bad workbook — a
 * caller-facing `error` string comes back instead, because this runs behind a
 * file upload where a stack trace would be the wrong answer.
 */
export function mapWorkbook(buf: Buffer, label = "workbook"): MappedWorkbook {
  issues = [];                       // see the CONCURRENCY note at the top
  const empty: MappedWorkbook = {
    sheetNames: [], date1904: false, pipeline: null, forecast: null,
    opps: [], forecasts: [], issues: [], rowsRead: 0, blankRows: 0, forecastRowsRead: 0,
  };

  let wb: Workbook;
  try {
    wb = readWorkbook(buf, label);
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : String(e) };
  }
  DATE_1904 = wb.date1904;

  const out: MappedWorkbook = { ...empty, sheetNames: wb.sheets.map((s) => s.name), date1904: wb.date1904 };

  // ── Pipeline sheet ────────────────────────────────────────────────────────
  const pipeSheet = wb.sheets.find((s) => /pipeline/i.test(s.name)) ?? wb.sheets[0];
  if (!pipeSheet) return { ...out, error: "the workbook has no sheets" };

  const pipeHdr = locateHeader(pipeSheet.grid, PIPE_FIELDS);
  const TOTAL_PIPE = Object.keys(PIPE_FIELDS).length;
  if (pipeHdr.row < 0 || pipeHdr.hits < 8) {
    return {
      ...out,
      error: `could not find a header row in "${pipeSheet.name}" — the best candidate matched only ` +
             `${Math.max(0, pipeHdr.hits)} of ${TOTAL_PIPE} expected columns. ` +
             `Expected headers like: Share/No Share, Date found, Agency/POC, RFx #, Due Date, Cature Stage.`,
    };
  }
  out.pipeline = {
    sheet: pipeSheet.name,
    headerRow: excelRow(pipeHdr.row),
    matched: pipeHdr.hits,
    total: TOTAL_PIPE,
    missing: Object.keys(PIPE_FIELDS).filter((f) => pipeHdr.map[f] === undefined),
  };

  const seen = new Set<string>();
  for (let r = pipeHdr.row + 1; r < pipeSheet.grid.length; r++) {
    const row = pipeSheet.grid[r] ?? [];
    if (row.slice(0, 20).filter((c) => text(c) !== null).length === 0) { out.blankRows++; continue; }
    out.rowsRead++;
    const m = mapPipelineRow(row, pipeHdr.map, r, seen);
    if (m) out.opps.push(m);
  }

  // ── Forecast sheet (optional) ─────────────────────────────────────────────
  const fcstSheet = wb.sheets.find((s) => /forecas/i.test(s.name));
  if (fcstSheet) {
    const hdr = locateHeader(fcstSheet.grid, FCST_FIELDS);
    if (hdr.hits >= 4) {
      out.forecast = {
        sheet: fcstSheet.name, headerRow: excelRow(hdr.row),
        matched: hdr.hits, total: Object.keys(FCST_FIELDS).length,
      };
      for (let r = hdr.row + 1; r < fcstSheet.grid.length; r++) {
        const row = fcstSheet.grid[r] ?? [];
        if (row.slice(0, 10).filter((c) => text(c) !== null).length === 0) continue;
        out.forecastRowsRead++;
        const m = mapForecastRow(row, hdr.map, r);
        if (m) out.forecasts.push(m);
      }
    }
  }

  out.issues = issues.slice();
  return out;
}

export type { MappedOpp, MappedForecast, Issue, Workbook, Cell };
