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
 * Kansas eSupplier — PeopleSoft Fluid (Oracle FSCM 9.2).
 *
 * Quirk 1: despite looking like a JS shell, the public bid list component
 * server-renders the whole grid on the first plain GET. Every cell is a
 * <span class='ps_box-value'> whose id is `<RECORD>_<FIELD>$<rowIndex>` — there is
 * no per-row class to anchor on, so we enumerate rows by the Event ID span
 * (`SCP_PUB_AUC_VW_AUC_ID$N`) and read the sibling fields by exact id. Literal `$`
 * in ids is why every selector here is an [id="..."] attribute match rather than
 * a `#id` selector (`$` would need CSS escaping).
 *
 * Quirk 2: clicking a row is an ICAction POST, not a link — so the grid exposes no
 * hrefs. But each event's detail page embeds its own "copy bid event link" URL
 * pointing at the KS_FSCM_APP_PK.KS_SCP_PUB_BIDLST component keyed by AUC_ID. That
 * deep link IS a GET-able, server-rendered page, so we use it both as detailUrl and
 * to enrich description/status. It returns "An error has occurred." unless the
 * PeopleSoft session cookie from the list GET is replayed — hence the CookieJar.
 *
 * Quirk 3 (source data, not a parse bug): Kansas itself emits the DESCRLONG
 * textarea with its first character missing on some events — the raw HTML literally
 * reads `>he State of Kansas is issuing...`. Do not "fix" this in the parser; the
 * character is not in the response. Descriptions are stored as served.
 */
const LIST_URL =
  "https://supplier.sok.ks.gov/psc/sokfsprdsup/SUPPLIER/ERP/c/SCP_PUBLIC_MENU_FL.SCP_PUB_BID_CMP_FL.GBL";

const DETAIL_BASE =
  "https://supplier.sok.ks.gov/psc/sokfsprdsup/SUPPLIER/ERP/c/KS_FSCM_APP_PK.KS_SCP_PUB_BIDLST.GBL" +
  "?Page=KS_SCP_PUB_BIDLST&Action=&&AUC_ID=";

/** How many detail pages we are willing to fetch in one run (each is a full page load). */
const MAX_DETAIL_FETCHES = 40;

type Row = cheerio.CheerioAPI;

/** Read a PeopleSoft field value span/textarea by its exact element id. */
function fieldById($: Row, id: string): string {
  return clean($(`[id="${id}"]`).first().text());
}

/**
 * PeopleSoft bounces the first request through a 302 that carries the session
 * cookies, and serves a "You must have cookies enabled" error page if they are not
 * replayed on the redirected request. undici's automatic redirect handling does not
 * re-send Set-Cookie values, so we follow hops by hand through the jar.
 */
async function getWithCookies(
  url: string,
  jar: CookieJar,
  signal: AbortSignal | undefined,
): Promise<string> {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const r = await request(current, { jar, signal, redirect: "manual" });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.res.headers.get("location");
      if (!loc) throw new Error(`GET ${current} -> HTTP ${r.status} without Location`);
      current = new URL(loc, current).toString();
      continue;
    }
    if (!r.ok) throw new Error(`GET ${current} -> HTTP ${r.status}`);
    return r.text;
  }
  throw new Error(`GET ${url} -> too many redirects`);
}

export const ksConnector: Connector = {
  key: "ks",
  label: "Kansas (PeopleSoft)",
  async fetchOpenOpportunities(opts: ConnectorRunOptions = {}): Promise<ConnectorResult> {
    const warnings: string[] = [];
    const jar = new CookieJar();

    const html = await getWithCookies(LIST_URL, jar, opts.signal);
    const $ = cheerio.load(html);

    const out: NormalizedOpportunity[] = [];

    $('span[id^="SCP_PUB_AUC_VW_AUC_ID$"]').each((_, el) => {
      try {
        const idAttr = $(el).attr("id") ?? "";
        const idx = idAttr.slice(idAttr.indexOf("$") + 1);
        if (!/^\d+$/.test(idx)) return;

        const externalId = clean($(el).text());
        if (!externalId) return;

        const title = fieldById($, `SCP_PUB_AUC_VW_AUC_NAME$${idx}`);
        const agency = fieldById($, `BUS_UNIT_AUC_VW_DESCR$${idx}`);
        const startText = fieldById($, `SCP_COSP_WK_FL_SCP_STRT_DATE_CHAR$${idx}`);
        const endText = fieldById($, `SCP_COSP_WK_FL_SCP_END_DATE_CHAR$${idx}`);
        // "Ends In" is a small HTML area ("23 hours, 37 mins" / "2 days" / "Ending Soon").
        const endsIn = clean($(`[id="win0divSCP_COSP_WK_FL_HTML_AREA_03$${idx}"]`).text());

        const postedIso = usDateToISO(startText, TZ_OFFSET_MIN.CT);

        out.push({
          externalId,
          title: title || externalId,
          agency: agency || null,
          postedDate: postedIso ? postedIso.slice(0, 10) : null,
          dueDate: usDateToISO(endText, TZ_OFFSET_MIN.CT),
          detailUrl: `${DETAIL_BASE}${encodeURIComponent(externalId)}`,
          statusOnSite: "Posted",
          raw: {
            rowIndex: Number(idx),
            startDateText: startText || null,
            endDateText: endText || null,
            endsIn: endsIn || null,
          },
        });
      } catch (e) {
        warnings.push(`row parse failed: ${(e as Error).message}`);
      }
    });

    if (out.length === 0) {
      warnings.push("no bid rows found in SCP_PUB_AUC_VW grid — PeopleSoft page layout may have changed");
    }

    const selected = opts.limit ? out.slice(0, opts.limit) : out;

    // Enrich with the server-rendered detail page (description, real status, line item).
    let enriched = 0;
    for (const opp of selected) {
      if (enriched >= MAX_DETAIL_FETCHES) break;
      if (opts.signal?.aborted) break;
      try {
        const detailHtml = await getWithCookies(opp.detailUrl as string, jar, opts.signal);
        const $d = cheerio.load(detailHtml);
        const confirmedId = fieldById($d, "KS_AUCDTL_VW_AUC_ID$0");
        if (confirmedId !== opp.externalId) {
          warnings.push(`${opp.externalId}: detail page returned "${confirmedId || "nothing"}"`);
          continue;
        }
        const descr = clean($d('textarea[id^="KS_AUCDTL_VW_DESCRLONG"]').first().text());
        const lineItem = clean($d('span[id^="KS_AUC_LN_VW_DESCR254_MIXED"]').first().text());
        const status = fieldById($d, "KS_AUCDTL_VW_AUC_STATUS$0");
        const contact = fieldById($d, "KS_AUCDTL_VW_NAME1$0");

        const descParts = [descr, lineItem].filter(Boolean);
        if (descParts.length) opp.description = trimDescription(descParts.join(" — "));
        if (lineItem) opp.category = lineItem;
        if (status) opp.statusOnSite = status;
        opp.raw = {
          ...opp.raw,
          contactName: contact || null,
          eventRound: fieldById($d, "KS_AUCDTL_VW_AUC_ROUND$0") || null,
          eventVersion: fieldById($d, "KS_AUCDTL_VW_AUC_VERSION$0") || null,
        };
        enriched++;
      } catch (e) {
        warnings.push(`${opp.externalId}: detail fetch failed: ${(e as Error).message}`);
      }
      await sleep(250);
    }

    return {
      opportunities: selected,
      warnings,
      methodUsed: "static_html (cheerio, PeopleSoft Fluid grid + AUC_ID deep-link details)",
    };
  },
};
