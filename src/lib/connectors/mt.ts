/**
 * Montana — Jaggaer/SciQuest "PublicEvent" sourcing site.
 *
 * Quirks worth knowing:
 *  - The list IS server-rendered HTML (no JS needed), but it is a Phoenix (Jaggaer)
 *    table that pages 20 rows at a time. Paging is a *form POST* back to the same
 *    URL, not a query string. So we GET once to harvest the <form name="ActiveForm">
 *    hidden inputs (one of them is a per-deploy random token name, e.g.
 *    "sst92835983746"), then re-POST that same body with PageSize bumped to grab
 *    every open event in a single response.
 *  - Each row is a single <tr>; the real fields live in label/value pairs
 *    (.data-row-name / .data-row-content) rather than columns, so we key off the
 *    visible label text ("Open", "Close", "Type", "Number", "Contact").
 *  - Dates render as "8/26/2026, 2:00 PM MDT" — note the comma, which usDateToISO's
 *    regex won't cross, and Mountain time, which TZ_OFFSET_MIN doesn't carry. We
 *    strip the comma and pick the offset off the MDT/MST abbreviation in the cell.
 *  - The title link (ViewSourcingEvent?AuthToken=…) and the "View as PDF" link
 *    (presigned S3, X-Amz-Expires=3600) are both short-lived. We keep them as the
 *    site issues them, but they are not durable permalinks.
 */
import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";

import type {
  Connector,
  ConnectorResult,
  ConnectorRunOptions,
  NormalizedOpportunity,
} from "@/lib/types";

import { fetchText, request, CookieJar } from "./http";
import { absolutize, clean, trimDescription, usDateToISO } from "./parse";

const BASE = "https://bids.sciquest.com/apps/Router/";
const LIST_URL = `${BASE}PublicEvent?CustomerOrg=StateOfMontana`;

/** Mountain Daylight / Standard offsets in minutes from UTC. */
const MDT_OFFSET_MIN = -360;
const MST_OFFSET_MIN = -420;

function mountainOffset(cellText: string): number {
  return /\bMST\b/i.test(cellText) ? MST_OFFSET_MIN : MDT_OFFSET_MIN;
}

/** "8/26/2026, 2:00 PM MDT" -> ISO UTC. */
function mtDateToISO(cellText: string): string | null {
  const s = clean(cellText).replace(/,/g, " ");
  return usDateToISO(s, mountainOffset(cellText));
}

/**
 * Pull the label/value pairs out of one result row.
 * Labels observed live: Open, Close, Type, Number, Contact, Details.
 */
function readFields($: cheerio.CheerioAPI, row: cheerio.Cheerio<AnyNode>): Record<string, string> {
  const fields: Record<string, string> = {};
  row.find(".table-row-layout").each((_, el) => {
    const name = clean($(el).find(".data-row-name").first().text());
    const value = clean($(el).find(".data-row-content").first().text());
    if (name && !(name in fields)) fields[name] = value;
  });
  return fields;
}

/** Rebuild the ActiveForm POST body from the rendered page, overriding page size. */
function buildPagingBody(html: string, pageSize: number): { action: string; body: string } | null {
  const $ = cheerio.load(html);
  const form = $('form[name="ActiveForm"]').first();
  if (form.length === 0) return null;
  const action = absolutize(LIST_URL, form.attr("action"));
  if (!action) return null;

  const params = new URLSearchParams();
  form.find('input[type="hidden"]').each((_, el) => {
    const name = $(el).attr("name");
    if (!name) return;
    params.set(name, $(el).attr("value") ?? "");
  });
  // ESSearchAfter is a search cursor for the *next* page; drop it so the bigger
  // PageSize request starts from the top of the result set.
  params.delete("ESSearchAfter");
  params.set("PageNum", "1");
  params.set("PageSize", String(pageSize));
  return { action, body: params.toString() };
}

function parseRows(html: string, warnings: string[]): NormalizedOpportunity[] {
  const $ = cheerio.load(html);
  const out: NormalizedOpportunity[] = [];

  $("table.table tbody tr, table.table > tr").each((idx, el) => {
    try {
      const row = $(el);
      const link = row.find("a.btn-link-header").first();
      const title = clean(link.text());
      if (!title) return;

      const fields = readFields($, row);
      const externalId = fields["Number"] || title;
      const statusOnSite = clean(row.find(".status-badge").first().text()) || null;
      const description = trimDescription(row.find(".label-mini").first().text());
      const detailUrl = absolutize(LIST_URL, link.attr("href"));

      const pdf = row.find('a[id^="SourcingPublicSite_BUTTON_PDF_VIEW"]').first();
      const pdfUrl = absolutize(LIST_URL, pdf.attr("href"));
      const attachmentUrls = pdfUrl
        ? [{ filename: `${externalId.replace(/[^\w.-]+/g, "_")}-event.pdf`, url: pdfUrl }]
        : undefined;

      out.push({
        externalId,
        title,
        agency: "State of Montana",
        category: fields["Type"] || null,
        naicsCode: null,
        description,
        postedDate: fields["Open"] ? mtDateToISO(fields["Open"]) : null,
        dueDate: fields["Close"] ? mtDateToISO(fields["Close"]) : null,
        qAndADeadline: null,
        estimatedValue: null,
        detailUrl,
        statusOnSite,
        attachmentUrls,
        raw: {
          fields,
          contact: fields["Contact"] ?? null,
          contactEmail: clean(row.find('a[href^="mailto:"]').first().text()) || null,
        },
      });
    } catch (e) {
      warnings.push(`mt: row ${idx} failed to parse: ${(e as Error).message}`);
    }
  });

  return out;
}

export const mtConnector: Connector = {
  key: "mt",
  label: "Montana (SciQuest/Jaggaer)",

  async fetchOpenOpportunities(opts: ConnectorRunOptions = {}): Promise<ConnectorResult> {
    const warnings: string[] = [];
    const jar = new CookieJar();
    let methodUsed = "static_html (cheerio)";

    const firstHtml = await fetchText(LIST_URL, { jar, signal: opts.signal });
    let opportunities = parseRows(firstHtml, warnings);

    // Try to collapse pagination into one response so we don't miss page 2+.
    const paging = buildPagingBody(firstHtml, 200);
    if (paging) {
      try {
        const r = await request(paging.action, {
          method: "POST",
          jar,
          signal: opts.signal,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Referer: LIST_URL,
          },
          body: paging.body,
        });
        if (r.ok) {
          const all = parseRows(r.text, warnings);
          if (all.length >= opportunities.length) {
            opportunities = all;
            methodUsed = "static_html (cheerio, form POST PageSize=200)";
          } else {
            warnings.push("mt: paged POST returned fewer rows than page 1; kept page 1");
          }
        } else {
          warnings.push(`mt: paged POST -> HTTP ${r.status}; only page 1 collected`);
        }
      } catch (e) {
        warnings.push(`mt: paged POST failed (${(e as Error).message}); only page 1 collected`);
      }
    } else {
      warnings.push("mt: ActiveForm not found; only page 1 collected");
    }

    if (opportunities.length === 0) warnings.push("mt: no rows parsed from PublicEvent list");

    return {
      opportunities: opts.limit ? opportunities.slice(0, opts.limit) : opportunities,
      warnings,
      methodUsed,
    };
  },
};
