import * as cheerio from "cheerio";
import { CookieJar, request } from "./http";
import { absolutize, clean, usDateToISO, trimDescription, TZ_OFFSET_MIN } from "./parse";
import type {
  Connector,
  ConnectorResult,
  ConnectorRunOptions,
  NormalizedOpportunity,
} from "@/lib/types";

/**
 * Pennsylvania eMarketplace — classic ASP.NET WebForms. Seed Search.aspx for the
 * ViewState/EventValidation + every form field, then POST the COMPLETE form back
 * with ddlRows=ALL to return every open solicitation in a single request.
 */
const BASE = "https://www.emarketplace.state.pa.us/";
const SEARCH = `${BASE}Search.aspx`;

type CheerioRoot = ReturnType<typeof cheerio.load>;

function serializeForm($: CheerioRoot): URLSearchParams {
  const params = new URLSearchParams();
  const form = $("form#aspnetForm");
  form.find("input[name]").each((_, el) => {
    const name = $(el).attr("name");
    if (!name) return;
    const type = ($(el).attr("type") || "text").toLowerCase();
    if (type === "radio" || type === "checkbox") {
      if ($(el).attr("checked") !== undefined) params.append(name, $(el).attr("value") ?? "on");
    } else if (type === "submit" || type === "button" || type === "image") {
      /* skip submit/buttons; we add the one we want explicitly */
    } else {
      params.append(name, $(el).attr("value") ?? "");
    }
  });
  form.find("select[name]").each((_, el) => {
    const name = $(el).attr("name");
    if (!name) return;
    let val = $(el).find("option[selected]").attr("value");
    if (val === undefined) val = $(el).find("option").first().attr("value") ?? "";
    params.append(name, val);
  });
  form.find("textarea[name]").each((_, el) => {
    const name = $(el).attr("name");
    if (name) params.append(name, $(el).text() ?? "");
  });
  return params;
}

function parseRows($: CheerioRoot): NormalizedOpportunity[] {
  const out: NormalizedOpportunity[] = [];
  $("#ctl00_MainBody_grdResults tr").each((_, tr) => {
    const row = $(tr);
    const link = row.find('a[id$="_HyperLink1"]').first();
    if (!link.length) return;
    const tds = row.find("td");
    if (tds.length < 11) return;
    const cell = (i: number) => clean(tds.eq(i).text());
    const href = link.attr("href") || "";
    const sidMatch = /SID=([^&]+)/i.exec(href);
    const sid = sidMatch ? decodeURIComponent(sidMatch[1]) : "";
    const externalId = cell(0) || sid;
    if (!externalId) return;

    out.push({
      externalId,
      title: cell(2) || clean(link.text()),
      category: cell(1) || null, // solicitation type (IFB/RFP/RFQ)
      agency: cell(4) || null,
      description: trimDescription(cell(3)),
      postedDate: usDateToISO(cell(7), TZ_OFFSET_MIN.ET),
      dueDate: usDateToISO(cell(8), TZ_OFFSET_MIN.ET),
      detailUrl: absolutize(BASE, sid ? `Solicitations.aspx?SID=${encodeURIComponent(sid)}` : href),
      statusOnSite: cell(10) || "Open",
      raw: { county: cell(5), contact: cell(11), bidOpen: cell(9), sid },
    });
  });
  return out;
}

export const paConnector: Connector = {
  key: "pa",
  label: "Pennsylvania eMarketplace",
  async fetchOpenOpportunities(opts: ConnectorRunOptions = {}): Promise<ConnectorResult> {
    const warnings: string[] = [];
    const jar = new CookieJar();

    // 1. Seed the form.
    const seed = await request(SEARCH, { jar, signal: opts.signal });
    if (!seed.ok) throw new Error(`PA seed HTTP ${seed.status}`);
    const $seed = cheerio.load(seed.text);
    const params = serializeForm($seed);
    params.set("__EVENTTARGET", "");
    params.set("__EVENTARGUMENT", "");
    params.set("ctl00$MainBody$ddlRows", "32767"); // "ALL"
    params.set("ctl00$MainBody$rdoArch", "0"); // open/active
    params.set("ctl00$MainBody$btnSearch", "Search");
    params.delete("ctl00$MainBody$btnCancel");
    params.delete("ctl00$MainBody$btnExport");

    // 2. Full POST.
    const r = await request(SEARCH, {
      method: "POST",
      jar,
      signal: opts.signal,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: SEARCH,
      },
      body: params.toString(),
    });
    if (!r.ok || /1app_offline/i.test(r.res.url)) {
      // Fall back to the default GET listing (first 10 rows) if the POST is rejected.
      warnings.push("PA full-list POST rejected; falling back to default 10-row GET");
      const opportunities = parseRows($seed);
      return {
        opportunities: opts.limit ? opportunities.slice(0, opts.limit) : opportunities,
        warnings,
        methodUsed: "aspnet (seed GET fallback)",
      };
    }
    const $ = cheerio.load(r.text);
    const opportunities = parseRows($);
    return {
      opportunities: opts.limit ? opportunities.slice(0, opts.limit) : opportunities,
      warnings,
      methodUsed: "aspnet_viewstate (full-form POST, ddlRows=ALL)",
    };
  },
};
