import * as cheerio from "cheerio";
import { CookieJar, request, sleep } from "./http";
import { clean, trimDescription, usDateToISO, TZ_OFFSET_MIN } from "./parse";
import type {
  Connector,
  ConnectorResult,
  ConnectorRunOptions,
  NormalizedOpportunity,
} from "@/lib/types";

/**
 * Oklahoma "Bidding Opportunities" — PeopleSoft Fluid (SCP_PUB_BID_CMP_FL).
 *
 * Three quirks drive the shape of this connector:
 *
 * 1. COOKIE HANDSHAKE. The first GET 302s twice; the session cookie
 *    (financials-PORTAL-PSJSESSIONID) is set on the FIRST hop. If you let fetch
 *    auto-follow, that cookie is dropped and PeopleSoft bounces you to
 *    `?cmd=login&errorPg=ckreq` ("You must have cookies enabled"). So we walk the
 *    redirect chain manually, ingesting Set-Cookie at every hop.
 *
 * 2. NO SEMANTIC MARKUP. The grid is a real HTML table, but every cell is an
 *    anonymous `<td class='ps_grid-cell'>`. The only stable handle is the
 *    PeopleSoft field id on the inner span: `<FIELDNAME>$<rowIndex>`. We therefore
 *    bucket all `span.ps_box-value` ids by their `$N` suffix rather than walking
 *    table columns.
 *
 * 3. DETAILS ARE A POSTBACK, NOT A URL. The chevron fires
 *    `submitAction_win0(form,'SCP_COSP_WK_FL_DESCR$N')`, an ICAction POST that needs
 *    a live ICSID + ICStateNum. There is no linkable detail URL, and `#ICBack`
 *    invalidates the session (302 -> logout). The only reliable way back to the list
 *    is to re-GET the component, which bumps ICStateNum. So enrichment is
 *    GET-list -> POST-detail, once per row, and it is strictly best-effort: any
 *    failure degrades to the list-only record instead of throwing.
 *
 * Portal timestamps are labelled "CST" year-round but are Oklahoma local time, so
 * we parse them as CT.
 */
const LIST_URL =
  "https://financials.ok.gov/psc/SOKLFP1DS/SUPPLIER/ERP/c/SCP_PUBLIC_MENU_FL.SCP_PUB_BID_CMP_FL.GBL";

/** Row fields as they appear in the list grid, keyed by PeopleSoft field name. */
interface ListRow {
  index: number;
  aucId: string;
  name: string;
  businessUnit: string;
  format: string;
  type: string;
  startDate: string;
  endDate: string;
}

/** Extra fields only available on the postback detail panel. */
interface DetailFields {
  status: string;
  descrLong: string;
  buyer: string;
  contact: string;
  paymentTerms: string;
  eventRound: string;
  eventVersion: string;
}

/** State needed to issue an ICAction postback against a live PeopleSoft session. */
interface PageState {
  html: string;
  icsid: string;
  stateNum: string;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * GET following redirects by hand so the cookie jar sees Set-Cookie on every hop.
 * Node's fetch auto-follow swallows intermediate cookies, which breaks PeopleSoft.
 */
async function getWithCookies(
  url: string,
  jar: CookieJar,
  signal?: AbortSignal,
): Promise<string> {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    const r = await request(current, {
      jar,
      signal,
      redirect: "manual",
      headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.res.headers.get("location");
      if (!loc) throw new Error(`GET ${current} -> HTTP ${r.status} with no Location`);
      current = new URL(loc, current).toString();
      continue;
    }
    if (!r.ok) throw new Error(`GET ${current} -> HTTP ${r.status}`);
    return r.text;
  }
  throw new Error(`GET ${url} -> too many redirects`);
}

function extractHidden(html: string, name: string): string {
  const re = new RegExp(`name='${name}'[^>]*value='([^']*)'`);
  return re.exec(html)?.[1] ?? "";
}

/** Fetch the list component and capture the ICSID/ICStateNum needed for postbacks. */
async function loadListPage(jar: CookieJar, signal?: AbortSignal): Promise<PageState> {
  const html = await getWithCookies(LIST_URL, jar, signal);
  return {
    html,
    icsid: extractHidden(html, "ICSID"),
    stateNum: extractHidden(html, "ICStateNum") || "1",
  };
}

/**
 * Pull `<span class='ps_box-value' id='FIELD$N'>value</span>` out of a PeopleSoft
 * page and bucket the values by row index N. `$N` is not a usable CSS id selector,
 * so we read the attribute and split it ourselves.
 */
function fieldsByRow($: cheerio.CheerioAPI): Map<number, Record<string, string>> {
  const rows = new Map<number, Record<string, string>>();
  $("span.ps_box-value").each((_, el) => {
    const id = $(el).attr("id");
    if (!id) return;
    const at = id.lastIndexOf("$");
    if (at === -1) return;
    const idx = Number(id.slice(at + 1));
    if (!Number.isInteger(idx)) return;
    const field = id.slice(0, at);
    let bucket = rows.get(idx);
    if (!bucket) {
      bucket = {};
      rows.set(idx, bucket);
    }
    bucket[field] = clean($(el).text());
  });
  return rows;
}

function parseListRows(html: string): ListRow[] {
  const $ = cheerio.load(html);
  const buckets = fieldsByRow($);
  const out: ListRow[] = [];
  for (const [index, f] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    const aucId = f["SCP_PUB_AUC_VW_AUC_ID"];
    if (!aucId) continue; // header/filter widgets also render ps_box-value spans
    out.push({
      index,
      aucId,
      name: f["SCP_PUB_AUC_VW_AUC_NAME"] ?? "",
      businessUnit: f["BUS_UNIT_AUC_VW_DESCR"] ?? "",
      format: f["SCP_PUB_AUC_VW_AUC_FORMAT"] ?? "",
      type: f["SCP_PUB_AUC_VW_AUC_TYPE"] ?? "",
      startDate: f["SCP_COSP_WK_FL_SCP_STRT_DATE_CHAR"] ?? "",
      endDate: f["SCP_COSP_WK_FL_SCP_END_DATE_CHAR"] ?? "",
    });
  }
  return out;
}

/**
 * The detail postback returns a PeopleSoft partial-page XML document whose real
 * markup is wrapped in CDATA. Unwrap the CDATA and hand the HTML to cheerio.
 */
function unwrapPartial(xml: string): string {
  return xml
    .replace(/<GENSCRIPT[\s\S]*?<\/GENSCRIPT>/g, "")
    .replace(/<GENJS[\s\S]*?<\/GENJS>/g, "")
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "");
}

/** POST the chevron ICAction for row `index` and read back the Event Details panel. */
async function fetchDetail(
  page: PageState,
  index: number,
  jar: CookieJar,
  signal?: AbortSignal,
): Promise<{ aucId: string; fields: DetailFields } | null> {
  const body = new URLSearchParams({
    ICAJAX: "1",
    ICType: "Panel",
    ICElementNum: "0",
    ICStateNum: page.stateNum,
    ICAction: `SCP_COSP_WK_FL_DESCR$${index}`,
    ICModelCancel: "0",
    ICXPos: "0",
    ICYPos: "0",
    ResponsetoDiffFrame: "-1",
    TargetFrameName: "None",
    FacetPath: "None",
    ICSaveWarningFilter: "1",
    ICChanged: "-1",
    ICSkipPending: "0",
    ICAutoSave: "0",
    ICResubmit: "0",
    ICSID: page.icsid,
    ICActionPrompt: "false",
  }).toString();

  const r = await request(LIST_URL, {
    method: "POST",
    jar,
    signal,
    redirect: "manual",
    body,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UA,
      Referer: LIST_URL,
    },
  });
  // A 302 here means PeopleSoft rejected the state token and logged the session out.
  if (r.status !== 200) return null;

  const $ = cheerio.load(unwrapPartial(r.text));
  const buckets = fieldsByRow($);
  const f = buckets.get(0);
  if (!f) return null;
  const aucId = f["SCP_P_AUCDTL_VW_AUC_ID"];
  if (!aucId) return null;

  // Description lives in a disabled <textarea>, not a ps_box-value span.
  const descrLong = clean($("textarea[id^='SCP_P_AUCDTL_VW_DESCRLONG']").first().text());

  return {
    aucId,
    fields: {
      status: f["SCP_P_AUCDTL_VW_AUC_STATUS"] ?? "",
      descrLong,
      buyer: f["PO_OPRDEFN_VW_OPRDEFNDESC"] ?? "",
      contact: f["SCP_P_AUCDTL_VW_NAME1"] ?? "",
      paymentTerms: f["PYMT_TR_EFF_VW_DESCR"] ?? "",
      eventRound: f["SCP_P_AUCDTL_VW_AUC_ROUND"] ?? "",
      eventVersion: f["SCP_P_AUCDTL_VW_AUC_VERSION"] ?? "",
    },
  };
}

export const okConnector: Connector = {
  key: "ok",
  label: "Oklahoma (PeopleSoft)",
  async fetchOpenOpportunities(opts: ConnectorRunOptions = {}): Promise<ConnectorResult> {
    const warnings: string[] = [];
    const jar = new CookieJar();

    const firstPage = await loadListPage(jar, opts.signal);
    const rows = parseListRows(firstPage.html);
    if (rows.length === 0) {
      warnings.push("Oklahoma list grid returned no SCP_PUB_AUC_VW_AUC_ID rows — layout may have changed.");
      return { opportunities: [], warnings, methodUsed: "static_html + peoplesoft ICAction postback" };
    }

    const selected = opts.limit ? rows.slice(0, opts.limit) : rows;
    const out: NormalizedOpportunity[] = [];
    let page: PageState = firstPage;
    let detailsOk = 0;

    for (let i = 0; i < selected.length; i++) {
      const row = selected[i];
      try {
        // Re-GET the component between details: the previous postback left the
        // session parked on the detail panel, and #ICBack logs the session out.
        if (i > 0) {
          await sleep(300);
          page = await loadListPage(jar, opts.signal);
        }

        let detail: DetailFields | null = null;
        try {
          const d = await fetchDetail(page, row.index, jar, opts.signal);
          if (d && d.aucId === row.aucId) {
            detail = d.fields;
            detailsOk++;
          } else if (d) {
            warnings.push(`Detail mismatch for row ${row.index}: expected ${row.aucId}, got ${d.aucId}.`);
          }
        } catch (e) {
          warnings.push(`Detail fetch failed for ${row.aucId}: ${(e as Error).message}`);
        }

        out.push({
          externalId: row.aucId,
          title: row.name || row.aucId,
          agency: row.businessUnit || null,
          category: row.type || null,
          description: trimDescription(detail?.descrLong) ?? null,
          postedDate: usDateToISO(row.startDate, TZ_OFFSET_MIN.CT),
          dueDate: usDateToISO(row.endDate, TZ_OFFSET_MIN.CT),
          detailUrl: LIST_URL,
          statusOnSite: detail?.status || "Posted",
          raw: {
            rowIndex: row.index,
            eventFormat: row.format || null,
            eventType: row.type || null,
            businessUnit: row.businessUnit || null,
            startDateRaw: row.startDate || null,
            endDateRaw: row.endDate || null,
            buyerName: detail?.buyer || null,
            contactName: detail?.contact || null,
            paymentTerms: detail?.paymentTerms || null,
            eventRound: detail?.eventRound || null,
            eventVersion: detail?.eventVersion || null,
          },
        });
      } catch (e) {
        warnings.push(`Row ${row.index} (${row.aucId}) failed: ${(e as Error).message}`);
      }
    }

    if (detailsOk === 0) {
      warnings.push("No detail panels could be loaded; records are list-only (no descriptions).");
    }

    return {
      opportunities: out,
      warnings,
      methodUsed: "static_html (cheerio) + peoplesoft ICAction postback for details",
    };
  },
};
