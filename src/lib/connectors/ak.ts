import { request } from "./http";
import { CookieJar } from "./http";
import { clean, trimDescription } from "./parse";
import type {
  Connector,
  ConnectorResult,
  ConnectorRunOptions,
  NormalizedOpportunity,
} from "@/lib/types";

/**
 * Alaska IRIS VSS — the same CGI Advantage 4 ("Sofia") Angular shell as Kentucky, so the
 * same trick applies: there is no per-page URL, every screen is a JSON POST to the single
 * endpoint /PRDVSS1X1/Advantage4, and the server rejects anything without a live session
 * triple (session_id/page_id/csrf_token).
 *
 * Two Alaska-specific quirks worth knowing:
 *
 *  1. https://iris-vss.alaska.gov/ is a bare redirect stub. The real application lives at
 *     /PRDVSS1X1/Advantage4 (note the deployment-specific "PRDVSS1X1" path segment — KY's
 *     is "vssprod-ext"), which is only discoverable from the <base href> and the
 *     `applicationUrl` fields embedded in the landing shell.
 *  2. Alaska's open-solicitation volume is genuinely tiny (single digits at the time of
 *     writing) because the state is still phasing departments onto IRIS. A near-empty
 *     result here is correct, NOT a broken scraper — the SHOW_TXT="1" (All) filter returns
 *     hundreds of historical/awarded records, which is how the low open count was confirmed.
 *     We deliberately keep SHOW_TXT="3" (Open) so awarded/closed noise stays out.
 *
 * Flow:
 *   1. GET the shell, harvest session_info + the JSESSIONID cookie,
 *   2. POST {actionType:"pageOpen", targetQualifiedName:"vss.page.VVSSX10019"} — the
 *      "View Published Solicitations" page. Its response already carries the first page of
 *      rows in data.ds_data.T1SO_SRCH_QRY.row_data (default filter SHOW_TXT="3" = Open),
 *   3. Only when the grid reports more rows than it sent, POST the grid's own paging action
 *      (actionCode:"show_lines", genericParam_1:"100") to widen the 20-row default window.
 *
 * Coded values (category / status) are not global lookups — they ship inline with the
 * pageOpen response under page_metadata.datasources.T1SO_SRCH_QRY.columns.<F>.codedValuesList
 * as an array of single-entry {code: label} objects, so we decode from the live payload
 * rather than hardcoding a map that would silently rot.
 *
 * Dates are epoch milliseconds (numbers), not display strings — no timezone math needed.
 * DOC_REF is doubly bracketed: "[RFP,08,270000001,1][RFP-08-270000001-1]"; the second group
 * is the human solicitation number and is our stable externalId.
 */

const BASE = "https://iris-vss.alaska.gov/PRDVSS1X1/Advantage4";
const ORIGIN = "https://iris-vss.alaska.gov";
const DS = "T1SO_SRCH_QRY";
const SOLICITATION_PAGE = "vss.page.VVSSX10019";
/** "Show Me" coded value 3 = Open (1=All, 4=Closing Soon, 8=Recent Awards). */
const SHOW_OPEN = "3";
const PAGE_SIZE = 100;

interface SessionInfo {
  session_id: string;
  page_id: string;
  csrf_token: string;
}

/** One grid row. Every field is optional because the portal emits "" for empty dates. */
interface SolicitationRow {
  SO_CAT_CD?: string;
  SO_STA?: string;
  DOC_CD?: string;
  DOC_DSCR?: string;
  DEPT_NM?: string;
  BUYR_NM?: string;
  DOC_REF?: string;
  DOC_CD_CONCAT?: string;
  SO_CLSNG_DT_TM?: number | string;
  PUB_DT?: number | string;
  AMND_DT?: number | string;
  INTENT_POSTED_DT?: number | string;
  PUB_BID_OP_DT?: number | string;
  BUYR_EMAIL_AD?: string;
  BUYR_PH_NO?: string;
  BUYR_FAX_NO?: string;
}

interface ColumnMeta {
  codedValuesList?: Record<string, string>[];
}

interface AdvantageResponse {
  session_info?: SessionInfo;
  checksum?: {
    DATASOURCE?: Record<string, number>;
    VIEW?: Record<string, number>;
  };
  page_metadata?: {
    datasources?: Record<string, { columns?: Record<string, ColumnMeta> }>;
  };
  data?: {
    ds_data?: Record<
      string,
      { row_data?: SolicitationRow[]; rows_sent?: number; rows_total?: number }
    >;
  };
}

/** Flatten [{ "010": "Financial Svcs" }, ...] into a lookup. */
function codedValues(res: AdvantageResponse, field: string): Record<string, string> {
  const list = res.page_metadata?.datasources?.[DS]?.columns?.[field]?.codedValuesList;
  const map: Record<string, string> = {};
  if (!Array.isArray(list)) return map;
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    for (const [code, label] of Object.entries(entry)) {
      if (typeof label === "string") map[code] = label;
    }
  }
  return map;
}

/** Advantage sends epoch-ms numbers for populated dates and "" for empty ones. */
function epochToISO(v: number | string | undefined): string | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** "[RFP,08,270000001,1][RFP-08-270000001-1]" -> "RFP-08-270000001-1". */
function solicitationNumber(docRef: string | undefined): string | null {
  const s = clean(docRef);
  if (!s) return null;
  const groups = s.match(/\[([^\]]*)\]/g);
  if (groups && groups.length >= 2) {
    return clean(groups[groups.length - 1].slice(1, -1)) || null;
  }
  return s || null;
}

async function post(
  body: unknown,
  jar: CookieJar,
  signal: AbortSignal | undefined,
): Promise<AdvantageResponse> {
  const r = await request(BASE, {
    method: "POST",
    jar,
    signal,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      Referer: BASE,
      Origin: ORIGIN,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${BASE} -> HTTP ${r.status}`);
  return JSON.parse(r.text) as AdvantageResponse;
}

export const akConnector: Connector = {
  key: "ak",
  label: "Alaska IRIS VSS",
  async fetchOpenOpportunities(opts: ConnectorRunOptions = {}): Promise<ConnectorResult> {
    const warnings: string[] = [];
    const jar = new CookieJar();

    // 1. Bootstrap shell — carries the session triple inline.
    const shell = await request(BASE, { jar, signal: opts.signal });
    if (!shell.ok) throw new Error(`GET ${BASE} -> HTTP ${shell.status}`);
    const siMatch = /"session_info"\s*:\s*(\{[^}]*\})/.exec(shell.text);
    if (!siMatch) {
      throw new Error("AK VSS: session_info not found in bootstrap HTML (Advantage shell changed)");
    }
    const session = JSON.parse(siMatch[1]) as SessionInfo;
    if (!session.session_id || !session.csrf_token) {
      throw new Error("AK VSS: bootstrap session_info incomplete");
    }

    // 2. Open the "View Published Solicitations" page (defaults to SHOW_TXT=3 / Open).
    let res = await post(
      {
        action: {
          params: { targetLocation: "noDisplay", targetComponentType: "SystemInquiryPage" },
          actionType: "pageOpen",
          targetQualifiedName: SOLICITATION_PAGE,
        },
        session_info: session,
      },
      jar,
      opts.signal,
    );

    const catMap = codedValues(res, "SO_CAT_CD");
    const staMap = codedValues(res, "SO_STA");

    // 3. Widen the 20-row default window only if the grid is actually holding rows back.
    const firstBlock = res.data?.ds_data?.[DS];
    const sent = firstBlock?.rows_sent ?? 0;
    const total = firstBlock?.rows_total ?? sent;
    const wantMore = total > sent && (!opts.limit || opts.limit > sent);
    if (wantMore) {
      const followUp = res.session_info ?? session;
      const dsChecksum = res.checksum?.DATASOURCE?.[DS];
      const viewChecksum = res.checksum?.VIEW?.gridView1;
      try {
        const wide = await post(
          {
            action: {
              key: `${SOLICITATION_PAGE}.gridView1.group1.cardGrid.grid1pagination`,
              actionType: "dsAction",
              actionCode: "show_lines",
              dsNameList: DS,
              genericParam_1: String(PAGE_SIZE),
              bypassPopupClose: false,
              isCarouselNavigation: true,
            },
            checksum: {
              DATASOURCE: { [DS]: dsChecksum },
              VIEW: { gridView1: viewChecksum },
              DS_DATA: { [DS]: "-1" },
            },
            viewState: {
              [SOLICITATION_PAGE]: {
                editable: false,
                hidden: false,
                closed: false,
                required: false,
                protected: false,
              },
            },
            data: { page_data: {}, ds_query_data: { [DS]: { SHOW_TXT: SHOW_OPEN } } },
            session_info: followUp,
          },
          jar,
          opts.signal,
        );
        if ((wide.data?.ds_data?.[DS]?.row_data?.length ?? 0) > 0) res = wide;
        else warnings.push("AK VSS: show_lines paging returned no rows; using first 20-row window");
      } catch (e) {
        warnings.push(`AK VSS: show_lines paging failed (${(e as Error).message}); using first window`);
      }
    }

    const block = res.data?.ds_data?.[DS];
    const rows = block?.row_data ?? [];
    if (rows.length === 0) {
      warnings.push(
        "AK VSS: solicitation grid returned zero open rows (Alaska routinely has very few; verify against the portal before treating as a failure)",
      );
    }
    const finalTotal = block?.rows_total ?? rows.length;
    if (!opts.limit && finalTotal > rows.length) {
      warnings.push(`AK VSS: ${finalTotal} open solicitations reported, ${rows.length} retrieved`);
    }

    const out: NormalizedOpportunity[] = [];
    for (const row of rows) {
      try {
        const externalId = solicitationNumber(row.DOC_REF);
        const title = clean(row.DOC_DSCR);
        if (!externalId || !title) {
          warnings.push("AK VSS: skipped row missing solicitation number or description");
          continue;
        }
        const category = row.SO_CAT_CD ? (catMap[row.SO_CAT_CD] ?? row.SO_CAT_CD) : null;
        const status = row.SO_STA ? (staMap[row.SO_STA] ?? row.SO_STA) : null;
        const buyer = clean(row.BUYR_NM);
        const docType = clean(row.DOC_CD_CONCAT);

        out.push({
          externalId,
          title,
          agency: clean(row.DEPT_NM) || null,
          category: category || null,
          description: trimDescription(
            [docType, buyer ? `Buyer: ${buyer}` : "", clean(row.BUYR_EMAIL_AD)]
              .filter(Boolean)
              .join(" — "),
          ),
          postedDate: epochToISO(row.PUB_DT),
          dueDate: epochToISO(row.SO_CLSNG_DT_TM),
          detailUrl: BASE,
          statusOnSite: status || null,
          raw: {
            solicitationType: docType || null,
            docCode: clean(row.DOC_CD) || null,
            categoryCode: clean(row.SO_CAT_CD) || null,
            statusCode: clean(row.SO_STA) || null,
            buyerName: buyer || null,
            buyerEmail: clean(row.BUYR_EMAIL_AD) || null,
            buyerPhone: clean(row.BUYR_PH_NO) || null,
            buyerFax: clean(row.BUYR_FAX_NO) || null,
            amendedDate: epochToISO(row.AMND_DT),
            intentPostedDate: epochToISO(row.INTENT_POSTED_DT),
            publicBidOpeningDate: epochToISO(row.PUB_BID_OP_DT),
            docRef: clean(row.DOC_REF) || null,
          },
        });
      } catch (e) {
        warnings.push(`AK VSS: row parse failed (${(e as Error).message})`);
      }
    }

    return {
      opportunities: opts.limit ? out.slice(0, opts.limit) : out,
      warnings,
      methodUsed: "json_api (CGI Advantage 4 pageOpen + show_lines POST)",
    };
  },
};
