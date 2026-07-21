import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { fetchText, sleep } from "./http";
import { absolutize, clean, trimDescription, usDateToISO, TZ_OFFSET_MIN } from "./parse";
import type {
  Connector,
  ConnectorResult,
  ConnectorRunOptions,
  NormalizedOpportunity,
} from "@/lib/types";

/**
 * Louisiana LaPAC (ColdFusion, Office of State Procurement).
 *
 * Quirks:
 *  - There is no "all open bids" listing. srchopen.cfm looks like a GET search form
 *    but re-renders the empty form for every query we tried, so the only reliable
 *    server-rendered index is deptbids.cfm, which links to one page per department
 *    (dspBid.cfm?search=department&term=N) and shows a live open-bid count in the
 *    link label. Departments with zero open bids are rendered WITHOUT an anchor, so
 *    we simply follow every anchor that exists and fan out sequentially.
 *  - Each solicitation is a <tr> whose first <td> holds the bid number in a <span>.
 *    Addenda are rendered as EXTRA sibling <tr>s with only 2 cells (description +
 *    issue date) while the bid-number / open-date / help cells use rowspan. So a row
 *    is a new opportunity iff its first cell contains that <span>; otherwise it is an
 *    addendum belonging to the previous opportunity.
 *  - The description cell mixes the title, an optional "Bid Cancelled:" marker, the
 *    "Original:" document link and an "Attachments:" list. The title is only the text
 *    nodes BEFORE the first <strong>, so we walk child nodes rather than take .text().
 *  - Cancelled solicitations get a sentinel open date of 12/30/9999; we drop it.
 */
const BASE = "https://wwwcfprd.doa.louisiana.gov/osp/lapac/";
const LIST_URL = `${BASE}deptbids.cfm`;

/** Politeness gap between department pages (ColdFusion box, ~25 live departments). */
const DEPT_DELAY_MS = 250;

interface Dept {
  term: string;
  name: string;
  url: string;
}

/** "*** State Procurement *** - (37)" -> name without the trailing count. */
function stripCount(label: string): string {
  return clean(label).replace(/\s*-\s*\(\d+\)\s*$/, "");
}

/** Text of the cell's child nodes up to the first <strong> — i.e. the title lines. */
function leadingText($: cheerio.CheerioAPI, td: cheerio.Cheerio<Element>): string {
  const parts: string[] = [];
  const children = td.contents().toArray() as AnyNode[];
  for (const node of children) {
    if (node.type === "tag") {
      const tag = (node as Element).tagName?.toLowerCase();
      if (tag === "strong" || tag === "a") break;
      if (tag === "br") {
        parts.push(" ");
        continue;
      }
    }
    parts.push($(node as AnyNode).text());
  }
  return clean(parts.join(""));
}

function attachmentsOf(
  $: cheerio.CheerioAPI,
  td: cheerio.Cheerio<Element>,
): { filename: string; url: string }[] {
  const out: { filename: string; url: string }[] = [];
  td.find("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    if (!href || href.toLowerCase().startsWith("javascript")) return;
    const url = absolutize(BASE, href);
    if (!url) return;
    const filename = clean($(a).text()) || url.split("/").pop() || "document";
    if (!out.some((x) => x.url === url)) out.push({ filename, url });
  });
  return out;
}

async function parseDeptPage(
  dept: Dept,
  opts: ConnectorRunOptions,
  warnings: string[],
): Promise<NormalizedOpportunity[]> {
  const html = await fetchText(dept.url, { signal: opts.signal });
  const $ = cheerio.load(html);
  const out: NormalizedOpportunity[] = [];

  $("table.bid tr").each((_, tr) => {
    try {
      const row = $(tr);
      const tds = row.find("> td");
      if (tds.length === 0) return; // header row

      const first = tds.eq(0);
      const idSpan = first.find("span").first();

      // Addendum continuation row: no bid-number span, 2 cells (desc + issued date).
      if (idSpan.length === 0) {
        const prev = out[out.length - 1];
        if (!prev || tds.length < 1) return;
        const descTd = tds.eq(tds.length >= 2 ? tds.length - 2 : 0) as cheerio.Cheerio<Element>;
        const note = leadingText($, descTd);
        const extra = attachmentsOf($, descTd);
        prev.attachmentUrls = [
          ...(prev.attachmentUrls ?? []),
          ...extra.filter((e) => !(prev.attachmentUrls ?? []).some((p) => p.url === e.url)),
        ];
        const addenda = (prev.raw?.addenda as string[] | undefined) ?? [];
        if (note) addenda.push(note);
        prev.raw = { ...(prev.raw ?? {}), addenda };
        return;
      }

      const externalId = clean(idSpan.text());
      if (!externalId || tds.length < 4) return;

      const descTd = tds.eq(1) as cheerio.Cheerio<Element>;
      const issuedText = clean(tds.eq(2).text());
      const openText = clean(tds.eq(3).text());

      const title = leadingText($, descTd);
      const fullDesc = clean(descTd.text());
      const cancelled = /Bid Cancelled/i.test(fullDesc);

      // 12/30/9999 is LaPAC's sentinel for cancelled/no-open-date rows.
      const dueDate = /12\/30\/9999/.test(openText)
        ? null
        : usDateToISO(openText, TZ_OFFSET_MIN.CT);

      const attachments = attachmentsOf($, descTd);
      // The "Original:" link is the solicitation document itself.
      const original = attachments.find((a) => clean(a.filename) === externalId) ?? attachments[0];

      out.push({
        externalId,
        title: title || externalId,
        agency: dept.name,
        description: trimDescription(fullDesc),
        postedDate: usDateToISO(issuedText, TZ_OFFSET_MIN.CT),
        dueDate,
        detailUrl: original?.url ?? dept.url,
        statusOnSite: cancelled ? "Cancelled" : "Open",
        attachmentUrls: attachments,
        raw: {
          departmentTerm: dept.term,
          department: dept.name,
          listingUrl: dept.url,
          openDateText: openText,
          issuedText,
        },
      });
    } catch (e) {
      warnings.push(`la: row parse failed on ${dept.name}: ${(e as Error).message}`);
    }
  });

  return out;
}

export const laConnector: Connector = {
  key: "la",
  label: "Louisiana LaPAC",
  async fetchOpenOpportunities(opts: ConnectorRunOptions = {}): Promise<ConnectorResult> {
    const warnings: string[] = [];
    const indexHtml = await fetchText(LIST_URL, { signal: opts.signal });
    const $ = cheerio.load(indexHtml);

    const depts: Dept[] = [];
    $('a[href*="dspBid.cfm"][href*="search=department"]').each((_, a) => {
      const href = $(a).attr("href");
      const url = absolutize(BASE, href);
      if (!url) return;
      const term = new URL(url).searchParams.get("term");
      if (!term || depts.some((d) => d.term === term)) return;
      depts.push({ term, name: stripCount($(a).text()), url });
    });

    if (depts.length === 0) {
      warnings.push("la: no department links found on deptbids.cfm — markup may have changed");
      return { opportunities: [], warnings, methodUsed: "static_html (cheerio)" };
    }

    const out: NormalizedOpportunity[] = [];
    const seen = new Set<string>();

    for (const dept of depts) {
      if (opts.signal?.aborted) {
        warnings.push("la: aborted before finishing department fan-out");
        break;
      }
      if (opts.limit && out.length >= opts.limit) break;
      try {
        for (const opp of await parseDeptPage(dept, opts, warnings)) {
          if (seen.has(opp.externalId)) continue;
          seen.add(opp.externalId);
          out.push(opp);
        }
      } catch (e) {
        warnings.push(`la: department "${dept.name}" (term=${dept.term}) failed: ${(e as Error).message}`);
      }
      await sleep(DEPT_DELAY_MS);
    }

    return {
      opportunities: opts.limit ? out.slice(0, opts.limit) : out,
      warnings,
      methodUsed: "static_html (cheerio)",
    };
  },
};
