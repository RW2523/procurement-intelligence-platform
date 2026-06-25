import * as cheerio from "cheerio";
import { fetchText } from "./http";
import { absolutize, clean, usDateToISO, TZ_OFFSET_MIN } from "./parse";
import type {
  Connector,
  ConnectorResult,
  ConnectorRunOptions,
  NormalizedOpportunity,
} from "@/lib/types";

/**
 * Arkansas OSP — legacy static HTML. Two tables (OSP + Other Units) differ by one
 * leading column, so we locate the bid-number anchor cell and read the other fields
 * by RELATIVE offset (desc = -3, agency = -2, opening = -1, buyer = +1) — consistent
 * across both tables.
 */
const LIST_URL = "https://www.arkansas.gov/tss/procurement/bids/index.php";
const DETAIL_BASE = "https://www.arkansas.gov/tss/procurement/bids/";

export const arConnector: Connector = {
  key: "ar",
  label: "Arkansas OSP Bids",
  async fetchOpenOpportunities(opts: ConnectorRunOptions = {}): Promise<ConnectorResult> {
    const warnings: string[] = [];
    const html = await fetchText(LIST_URL, { signal: opts.signal });
    const $ = cheerio.load(html);
    const out: NormalizedOpportunity[] = [];

    $('a[href^="bid_info.php?bid_number="]').each((_, a) => {
      const anchor = $(a);
      const td = anchor.closest("td");
      const row = anchor.closest("tr");
      const tds = row.find("td");
      const b = tds.index(td);
      if (b < 0) return;

      const externalId = clean(anchor.text());
      if (!externalId) return;
      const detailUrl = absolutize(DETAIL_BASE, anchor.attr("href"));

      const cellText = (i: number) => (i >= 0 && i < tds.length ? clean(tds.eq(i).text()) : "");
      const title = cellText(b - 3) || cellText(b - 2);
      const agency = cellText(b - 2);
      const openingText = cellText(b - 1);
      const buyerEmail = row.find('a[href^="mailto:"]').first().attr("href")?.replace("mailto:", "") ?? null;

      // amendment date appears as "Bid Updated on" / a trailing date in the bid cell
      const amendImg = td.find('img[alt*="Updated"]').attr("alt") || "";

      out.push({
        externalId,
        title: title || externalId,
        agency: agency || null,
        dueDate: usDateToISO(openingText, TZ_OFFSET_MIN.CT),
        detailUrl,
        statusOnSite: amendImg ? "Amended" : "Open",
        raw: { buyerEmail, amendInfo: amendImg || null },
      });
    });

    // Dedupe (a bid can appear once per table in edge cases).
    const byId = new Map<string, NormalizedOpportunity>();
    for (const o of out) if (!byId.has(o.externalId)) byId.set(o.externalId, o);
    const opportunities = [...byId.values()];

    return {
      opportunities: opts.limit ? opportunities.slice(0, opts.limit) : opportunities,
      warnings,
      methodUsed: "static_html (cheerio, relative-offset rows)",
    };
  },
};
