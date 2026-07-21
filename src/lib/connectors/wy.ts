import * as cheerio from "cheerio";
import { fetchText } from "./http";
import { absolutize, clean, trimDescription } from "./parse";
import type {
  Connector,
  ConnectorResult,
  ConnectorRunOptions,
  NormalizedOpportunity,
} from "@/lib/types";

/**
 * Wyoming — Public Purchase GEMS "public info" board.
 *
 * The quirk: the bid table ships as EMPTY `<tr id="tr_N">` rows plus an inline
 * script that fills them via Prototype's `$("tr_N").update('<td>...')`. Worse,
 * every real value is deliberately shredded into `<span id="RANDOM">` fragments
 * interleaved with decoy spans full of junk text, and a trailing list of
 * `action("id","id",...)` calls hides the decoys (publicInfo.js: `$(id).hide()`).
 *
 * So we do exactly what the browser does, minus the browser:
 *   1. collect every id passed to `action(...)` -> the decoy set,
 *   2. re-evaluate the `tooltip = '...' + ...` / `update(...)` string concatenation
 *      by hand (a tiny JS single-quoted-string scanner),
 *   3. load the reconstructed row into cheerio, drop the decoy spans,
 *   4. read the remaining text, which is the genuine cell content.
 *
 * Everything is on the one page (no pagination) and times carry an explicit
 * MDT/MST suffix, so no timezone guessing is needed.
 */
const ORIGIN = "https://www.publicpurchase.com";
const LIST_URL = `${ORIGIN}/gems/wyominggsd,wy/buyer/public/publicInfo`;

/** Mountain Time offsets, chosen by the abbreviation printed in the cell. */
const MDT_OFFSET_MIN = -360;
const MST_OFFSET_MIN = -420;

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Parse the portal's "Jul 15, 2026 9:00:00 AM MDT" (and the long-month form used
 * in descriptions, e.g. "AUGUST 5, 2026"). Returns an ISO UTC datetime or null.
 */
function wyDateToISO(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = clean(input);
  const m =
    /([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])\.?[Mm]\.?)?(?:\s+(M[SD]T|[A-Z]{2,4}))?/.exec(
      s,
    );
  if (!m) return null;
  const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (month === undefined) return null;
  const day = Number(m[2]);
  const year = Number(m[3]);
  let hour = m[4] ? Number(m[4]) : 0;
  const min = m[5] ? Number(m[5]) : 0;
  const sec = m[6] ? Number(m[6]) : 0;
  if (m[7]) {
    const pm = /p/i.test(m[7]);
    if (pm && hour < 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
  }
  const offset = m[8] === "MST" ? MST_OFFSET_MIN : MDT_OFFSET_MIN;
  const d = new Date(Date.UTC(year, month, day, hour, min, sec) - offset * 60_000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Undo the escaping the portal applies inside its single-quoted JS literals. */
function unescapeJsString(s: string): string {
  return s.replace(/\\(.)/g, (_all, ch: string) => {
    if (ch === "n") return "\n";
    if (ch === "t") return "\t";
    if (ch === "r") return "";
    return ch;
  });
}

/** Read a single-quoted JS string literal starting at `src[i] === "'"`. */
function readStringLiteral(src: string, i: number): { value: string; next: number } {
  let out = "";
  let p = i + 1;
  while (p < src.length) {
    const ch = src[p];
    if (ch === "\\") {
      out += ch + (src[p + 1] ?? "");
      p += 2;
      continue;
    }
    if (ch === "'") return { value: unescapeJsString(out), next: p + 1 };
    out += ch;
    p += 1;
  }
  return { value: unescapeJsString(out), next: p };
}

/**
 * Evaluate a string-concatenation expression: `'lit' + 214313 + '\">' + tooltip`.
 * Stops at the first top-level terminator char. Returns the joined value.
 */
function readConcatExpr(
  src: string,
  start: number,
  terminators: string,
  tooltip: string,
): { value: string; next: number } {
  let out = "";
  let p = start;
  while (p < src.length) {
    const ch = src[p];
    if (terminators.includes(ch)) break;
    if (ch === "'") {
      const lit = readStringLiteral(src, p);
      out += lit.value;
      p = lit.next;
      continue;
    }
    if (ch >= "0" && ch <= "9") {
      const num = /^\d+/.exec(src.slice(p))?.[0] ?? "";
      out += num;
      p += num.length;
      continue;
    }
    if (src.startsWith("tooltip", p)) {
      out += tooltip;
      p += "tooltip".length;
      continue;
    }
    p += 1;
  }
  return { value: out, next: p };
}

interface RawRow {
  index: number;
  html: string;
}

/**
 * Walk the inline script, re-running the `tooltip` accumulation and the
 * `$("tr_N").update(...)` concatenation to recover each row's real HTML.
 */
function extractRows(script: string): RawRow[] {
  const rows: RawRow[] = [];
  const token = /tooltip\s*(\+?)=\s*'|\$\("tr_(\d+)"\)\.update\(/g;
  let tooltip = "";
  let m: RegExpExecArray | null;
  while ((m = token.exec(script)) !== null) {
    if (m[2] === undefined) {
      // tooltip = <expr>;  /  tooltip += <expr>;
      const expr = readConcatExpr(script, token.lastIndex - 1, ";", tooltip);
      tooltip = m[1] === "+" ? tooltip + expr.value : expr.value;
      token.lastIndex = expr.next;
      continue;
    }
    // $("tr_N").update(<expr>);
    const expr = readConcatExpr(script, token.lastIndex, ")", tooltip);
    rows.push({ index: Number(m[2]), html: expr.value });
    token.lastIndex = expr.next;
  }
  return rows;
}

/** Every id passed to action(...) is a decoy span the browser hides. */
function extractDecoyIds(script: string): Set<string> {
  const ids = new Set<string>();
  const callRe = /\baction\(([^)]*)\)/g;
  let call: RegExpExecArray | null;
  while ((call = callRe.exec(script)) !== null) {
    const argRe = /"([^"]*)"/g;
    let arg: RegExpExecArray | null;
    while ((arg = argRe.exec(call[1])) !== null) if (arg[1]) ids.add(arg[1]);
  }
  return ids;
}

/** Best-effort Q&A deadline: the date named in the "Questions ..." sentence. */
function questionDeadline(description: string): string | null {
  const idx = description.search(/questions?\b/i);
  if (idx === -1) return null;
  const window = description.slice(idx, idx + 400);
  const m =
    /([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})/.exec(window);
  if (!m) return null;
  const time = /(\d{1,2}):(\d{2})\s*([ap])\.?\s*m\.?/i.exec(window.slice(0, m.index));
  const stamp = time ? `${m[1]} ${time[1]}:${time[2]}:00 ${time[3].toUpperCase()}M MDT` : m[1];
  return wyDateToISO(stamp);
}

export const wyConnector: Connector = {
  key: "wy",
  label: "Wyoming (PublicPurchase)",
  async fetchOpenOpportunities(opts: ConnectorRunOptions = {}): Promise<ConnectorResult> {
    const warnings: string[] = [];
    const html = await fetchText(LIST_URL, { signal: opts.signal });

    const $page = cheerio.load(html);
    const pageTitle = clean($page("title").text());
    const agency = /:\s*(.+?)\s+Home Page/i.exec(pageTitle)?.[1] ?? "State of Wyoming";

    // The row-building script is the inline one that references tr_N.update.
    const script = $page("script")
      .toArray()
      .map((el) => $page(el).html() ?? "")
      .find((s) => s.includes('").update(') && s.includes("tooltip")) ?? "";

    if (!script) {
      warnings.push("row-building inline script not found — page layout may have changed");
      return { opportunities: [], warnings, methodUsed: "static_html (cheerio + inline-script decode)" };
    }

    const decoys = extractDecoyIds(script);
    const rows = extractRows(script);
    if (decoys.size === 0) warnings.push("no action(...) decoy ids found; cell text may contain junk");

    const out: NormalizedOpportunity[] = [];
    for (const row of rows) {
      try {
        const $ = cheerio.load(`<table><tbody><tr>${row.html}</tr></tbody></table>`);
        $("span[id]").each((_, el) => {
          const id = $(el).attr("id");
          if (id && decoys.has(id)) $(el).remove();
        });

        const tds = $("tr").first().children("td");
        const cell = (i: number) => (i < tds.length ? clean(tds.eq(i).text()) : "");

        const anchor = $("a[href*='bidId=']").first();
        const href = anchor.attr("href") ?? "";
        const bidId = /bidId=(\d+)/.exec(href)?.[1] ?? "";
        if (!bidId) {
          warnings.push(`row ${row.index}: no bidId in link — skipped`);
          continue;
        }

        const descEl = $("div.balloonstyle").first();
        const description = clean(descEl.text());
        // The title cell also contains the balloon div; strip it before reading text.
        descEl.remove();
        const title = clean(anchor.text()) || cell(0);
        if (!title) {
          warnings.push(`row ${row.index}: empty title (bid ${bidId}) — skipped`);
          continue;
        }

        const postedISO = wyDateToISO(cell(1));
        const addendums = cell(4);
        // Titles read "Bid #0014-N - ..." / "RFP #0002-N - ..." / "Invitation For Bid #0309-M - ...".
        const heading = /^(.*?)#\s*(.+?)\s+-\s+/.exec(title);

        out.push({
          externalId: bidId,
          title,
          agency,
          category: heading ? clean(heading[1]) || null : null,
          description: trimDescription(description),
          postedDate: postedISO ? postedISO.slice(0, 10) : null,
          dueDate: wyDateToISO(cell(2)),
          qAndADeadline: questionDeadline(description),
          detailUrl: absolutize(ORIGIN, href),
          statusOnSite: "Open",
          raw: {
            solicitationNumber: heading ? clean(heading[2]) : null,
            startDateText: cell(1),
            endDateText: cell(2),
            timeLeft: cell(3),
            addendums: addendums || null,
          },
        });
      } catch (err) {
        warnings.push(`row ${row.index}: parse failed — ${(err as Error).message}`);
      }
    }

    // A bid can only be listed once, but guard anyway.
    const byId = new Map<string, NormalizedOpportunity>();
    for (const o of out) if (!byId.has(o.externalId)) byId.set(o.externalId, o);
    const opportunities = [...byId.values()];

    if (opportunities.length === 0) warnings.push("no rows decoded from publicInfo page");

    return {
      opportunities: opts.limit ? opportunities.slice(0, opts.limit) : opportunities,
      warnings,
      methodUsed: "static_html (cheerio + inline-script decode, decoy spans stripped)",
    };
  },
};
