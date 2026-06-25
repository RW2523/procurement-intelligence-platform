import * as cheerio from "cheerio";
import { fetchText, sleep } from "./http";
import { absolutize, clean, findDates, usDateToISO, TZ_OFFSET_MIN } from "./parse";
import type {
  Connector,
  ConnectorResult,
  ConnectorRunOptions,
  NormalizedOpportunity,
} from "@/lib/types";

/**
 * Tennessee CPO — static HTML. Two listing pages (RFP + ITB) share one table
 * structure: td[0]=ID + attachment links, td[1]=Event Start / Response Due dates,
 * td[2]=title. The "detail page" is the linked solicitation PDF.
 */
const BASE = "https://www.tn.gov";
const PAGES: { url: string; category: string }[] = [
  {
    url: `${BASE}/generalservices/procurement/central-procurement-office--cpo-/supplier-information/request-for-proposals--rfp--opportunities1.html`,
    category: "RFP",
  },
  {
    url: `${BASE}/generalservices/procurement/central-procurement-office--cpo-/supplier-information/invitations-to-bid--itb-.html`,
    category: "ITB",
  },
];

function parsePage(html: string, category: string): NormalizedOpportunity[] {
  const $ = cheerio.load(html);
  const out: NormalizedOpportunity[] = [];
  const rows = $("table").first().find("tr").toArray().slice(1); // skip header
  for (const row of rows) {
    const tds = $(row).find("td");
    if (tds.length < 3) continue;
    const cell0 = tds.eq(0);
    const links = cell0
      .find("a[href]")
      .toArray()
      .map((a) => ({ text: clean($(a).text()), href: $(a).attr("href") || "" }))
      .filter((l) => l.text && l.href);
    if (!links.length) continue;

    const detailUrl = absolutize(BASE, links[0].href);
    // external id from link text, normalizing the non-breaking space separator
    let externalId = links[0].text.replace(/^(RFP|ITB|RFI|Event)[\s ]*/i, "").trim();
    if (!externalId && detailUrl) {
      const m = /(rfp|itb|rfi)-updates\/([^/]+)\//i.exec(detailUrl);
      externalId = m?.[2] ?? "";
    }
    if (!externalId) continue;

    const dates = findDates(tds.eq(1).text());
    const attachments = links.slice(1).map((l) => ({
      filename: l.text,
      url: absolutize(BASE, l.href) || l.href,
    }));

    out.push({
      externalId,
      title: clean(tds.eq(2).text()) || links[0].text,
      category,
      postedDate: usDateToISO(dates[0], TZ_OFFSET_MIN.CT),
      dueDate: usDateToISO(dates[1], TZ_OFFSET_MIN.CT),
      detailUrl,
      attachmentUrls: attachments,
      statusOnSite: "Open",
      raw: { category },
    });
  }
  return out;
}

export const tnConnector: Connector = {
  key: "tn",
  label: "Tennessee Procurement",
  async fetchOpenOpportunities(opts: ConnectorRunOptions = {}): Promise<ConnectorResult> {
    const warnings: string[] = [];
    const byId = new Map<string, NormalizedOpportunity>();
    for (const page of PAGES) {
      try {
        const html = await fetchText(page.url, { signal: opts.signal });
        for (const o of parsePage(html, page.category)) {
          if (!byId.has(o.externalId)) byId.set(o.externalId, o);
        }
      } catch (e) {
        warnings.push(`TN ${page.category} page: ${(e as Error).message}`);
      }
      await sleep(1000);
      if (opts.limit && byId.size >= opts.limit) break;
    }
    const opportunities = [...byId.values()];
    return {
      opportunities: opts.limit ? opportunities.slice(0, opts.limit) : opportunities,
      warnings,
      methodUsed: "static_html (cheerio, RFP+ITB tables)",
    };
  },
};
