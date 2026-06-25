import * as cheerio from "cheerio";
import { request } from "./http";
import { absolutize, clean, usDateToISO, TZ_OFFSET_MIN } from "./parse";
import type {
  Connector,
  ConnectorResult,
  ConnectorRunOptions,
  NormalizedOpportunity,
} from "@/lib/types";

/**
 * Massachusetts COMMBUYS (Periscope BSO / PrimeFaces JSF). Page 1 of open bids is
 * fully server-rendered and fetchable via httpx (25 rows). Deeper pages are stateful
 * JSF AJAX, so we drive Playwright to click through the paginator when available —
 * falling back to page 1 if the browser isn't installed.
 */
const BASE = "https://www.commbuys.com";
const LIST_URL = `${BASE}/bso/view/search/external/advancedSearchBid.xhtml?openBids=true`;
const DETAIL = (id: string) =>
  `${BASE}/bso/external/bidDetail.sda?docId=${encodeURIComponent(id)}&external=true&parentUrl=close`;

function parseRows(html: string): NormalizedOpportunity[] {
  const $ = cheerio.load(html);
  const out: NormalizedOpportunity[] = [];
  $('tbody[id$="bidResultId_data"] tr[data-ri]').each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length < 8) return;
    const cell = (i: number) => clean(tds.eq(i).text());
    const externalId = cell(0);
    if (!externalId) return;
    out.push({
      externalId,
      title: cell(6) || externalId,
      agency: cell(2) || null,
      dueDate: usDateToISO(cell(7), TZ_OFFSET_MIN.ET),
      detailUrl: DETAIL(externalId),
      statusOnSite: cell(10) || "Sent",
      raw: { buyer: cell(5), altId: cell(11) },
    });
  });
  return out;
}

function totalCount(html: string): number | null {
  const m = /(\d[\d,]*)\s*$/.exec(
    cheerio.load(html)(".ui-paginator-current").first().text().trim(),
  );
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

async function deepPaginate(maxPages: number, signal?: AbortSignal): Promise<NormalizedOpportunity[]> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });
    await page.goto(LIST_URL, { waitUntil: "networkidle", timeout: 45_000 });
    const byId = new Map<string, NormalizedOpportunity>();
    for (let p = 0; p < maxPages; p++) {
      if (signal?.aborted) break;
      const html = await page.content();
      for (const o of parseRows(html)) byId.set(o.externalId, o);
      const next = page.locator("a.ui-paginator-next:not(.ui-state-disabled)").first();
      if ((await next.count()) === 0) break;
      await next.click();
      await page.waitForTimeout(1500);
    }
    return [...byId.values()];
  } finally {
    await browser.close();
  }
}

export const maConnector: Connector = {
  key: "ma",
  label: "Massachusetts COMMBUYS",
  async fetchOpenOpportunities(opts: ConnectorRunOptions = {}): Promise<ConnectorResult> {
    const warnings: string[] = [];

    // Reliable baseline: page 1 via httpx.
    const seed = await request(LIST_URL, { signal: opts.signal });
    if (!seed.ok) throw new Error(`MA list HTTP ${seed.status}`);
    let opportunities = parseRows(seed.text);
    const total = totalCount(seed.text);
    let methodUsed = "static_html (httpx page 1)";

    // Deeper coverage via Playwright when not doing a quick smoke run.
    const maxPages = opts.limit ? 1 : 4;
    if (!opts.limit && maxPages > 1) {
      try {
        const deep = await deepPaginate(maxPages, opts.signal);
        if (deep.length >= opportunities.length) {
          opportunities = deep;
          methodUsed = `jsf_playwright (${maxPages} pages of ${total ?? "?"})`;
        }
      } catch (e) {
        warnings.push(`MA Playwright pagination unavailable, using page 1: ${(e as Error).message}`);
      }
    }
    if (total && opportunities.length < total) {
      warnings.push(`MA: fetched ${opportunities.length} of ${total} open bids (paged crawl capped)`);
    }

    return {
      opportunities: opts.limit ? opportunities.slice(0, opts.limit) : opportunities,
      warnings,
      methodUsed,
    };
  },
};
