import { fetchJson } from "./http";
import { trimDescription, usDateToISO, TZ_OFFSET_MIN } from "./parse";
import type {
  Connector,
  ConnectorResult,
  ConnectorRunOptions,
  NormalizedOpportunity,
} from "@/lib/types";

/**
 * West Virginia Purchasing Division (wvOASIS).
 *
 * Quirks:
 *  1. The obvious ".../Awards/awarded.html" page is AWARDED contracts, and
 *     ".../Bids/default.html" is an archive of bid-OPENING results (which vendors
 *     submitted on a given day). Neither lists open solicitations.
 *     Open solicitations live behind the "Fetch Bids" button on three category
 *     pages (Commodities.html, ConstructionBids.html, ArchitectureandEngineering.html).
 *     Those pages are JS shells that POST to a JSON endpoint on apps.wvoasis.gov
 *     with a static X-Api-Token embedded in the page source. We call that endpoint
 *     directly — one POST per category filter.
 *  2. The API returns CLSNG_TM as a 12-hour clock string with NO meridiem
 *     ("01:30", "10:00"). WV bid openings are business-hours-only, so we resolve
 *     the meridiem deterministically: hours 8-11 => AM, 12 and 1-7 => PM. The
 *     untouched CLSNG_DT/CLSNG_TM are preserved in `raw` so nothing is lost.
 *  3. There is no per-solicitation deep link; documents are retrieved from the
 *     wvOASIS Vendor Self Service portal. detailUrl points at the category page
 *     the record came from.
 */
const API_URL = "https://apps.wvoasis.gov/api/Purchasing/Bids.ashx";
// Public token hard-coded in the page source of the WV category pages.
const API_TOKEN = "2058e13f-d87e-490e-88a3-c89405392a6b";

interface WvBidRow {
  DOC_DSCR: string | null;
  DOC_DEPT_CD: string | null;
  DEPT_NM: string | null;
  DOC_CD: string | null;
  DOC_ID: string | null;
  DOC_VERS_NO: number | null;
  SO_CAT_CD: string | null;
  SO_DSCR: string | null;
  PUB_DT: string | null;
  CLSNG_DT: string | null;
  CLSNG_TM: string | null;
}

interface WvCategory {
  filter: string;
  label: string;
  pageUrl: string;
}

const CATEGORIES: WvCategory[] = [
  {
    filter: "CS",
    label: "Commodities & Services",
    pageUrl: "https://www.state.wv.us/admin/purchase/Commodities.html",
  },
  {
    filter: "Con",
    label: "Construction",
    pageUrl: "https://www.state.wv.us/admin/purchase/ConstructionBids.html",
  },
  {
    filter: "AE",
    label: "Architecture & Engineering",
    pageUrl: "https://www.state.wv.us/admin/purchase/ArchitectureandEngineering.html",
  },
];

/** "2026-07-22" -> "7/22/2026" so it can go through usDateToISO. */
function isoDayToUS(day: string | null | undefined): string | null {
  if (!day) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!m) return null;
  return `${Number(m[2])}/${Number(m[3])}/${m[1]}`;
}

/** Resolve WV's meridiem-less 12-hour closing time. See quirk (2) above. */
function meridiemFor(time: string | null | undefined): string | null {
  if (!time) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  if (hour < 1 || hour > 12) return null;
  const ap = hour >= 8 && hour <= 11 ? "AM" : "PM";
  return `${hour}:${m[2]} ${ap}`;
}

function closingToISO(day: string | null, time: string | null): string | null {
  const us = isoDayToUS(day);
  if (!us) return null;
  const t = meridiemFor(time);
  return usDateToISO(t ? `${us} ${t}` : us, TZ_OFFSET_MIN.ET);
}

export const wvConnector: Connector = {
  key: "wv",
  label: "West Virginia Purchasing",
  async fetchOpenOpportunities(opts: ConnectorRunOptions = {}): Promise<ConnectorResult> {
    const warnings: string[] = [];
    const out: NormalizedOpportunity[] = [];
    const seen = new Set<string>();

    for (const cat of CATEGORIES) {
      if (opts.signal?.aborted) break;

      let rows: WvBidRow[];
      try {
        rows = await fetchJson<WvBidRow[]>(API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "X-Api-Token": API_TOKEN,
            Origin: "https://www.state.wv.us",
            Referer: cat.pageUrl,
          },
          body: JSON.stringify({ filter: cat.filter }),
          signal: opts.signal,
        });
      } catch (e) {
        warnings.push(`wv: ${cat.label} fetch failed: ${(e as Error).message}`);
        continue;
      }

      if (!Array.isArray(rows)) {
        warnings.push(`wv: ${cat.label} returned a non-array payload`);
        continue;
      }

      for (const row of rows) {
        try {
          const docId = row.DOC_ID?.trim();
          if (!docId) {
            warnings.push(`wv: ${cat.label} row missing DOC_ID, skipped`);
            continue;
          }
          // Matches the "0304_TOR2600000001" identifier WV itself prints on its
          // bid-opening pages. Version is deliberately excluded so amendments
          // update the same record instead of creating a new one.
          const dept = row.DOC_DEPT_CD?.trim() ?? "";
          const externalId = dept ? `${dept}_${docId}` : docId;
          if (seen.has(externalId)) continue;
          seen.add(externalId);

          const title = row.DOC_DSCR?.trim() || docId;
          const docType = row.DOC_CD?.trim() || null;

          out.push({
            externalId,
            title,
            agency: row.DEPT_NM?.trim() || null,
            category: row.SO_DSCR?.trim() || cat.label,
            description: trimDescription(
              [docType ? `${docType} ${docId}` : docId, row.DOC_DSCR?.trim()]
                .filter(Boolean)
                .join(" — "),
            ),
            postedDate: row.PUB_DT?.trim() || null,
            dueDate: closingToISO(row.CLSNG_DT, row.CLSNG_TM),
            detailUrl: cat.pageUrl,
            statusOnSite: "Open",
            raw: {
              docCd: docType,
              docId,
              docDeptCd: dept || null,
              docVersNo: row.DOC_VERS_NO,
              soCatCd: row.SO_CAT_CD,
              soDscr: row.SO_DSCR,
              pubDt: row.PUB_DT,
              clsngDt: row.CLSNG_DT,
              clsngTm: row.CLSNG_TM,
              wvFilter: cat.filter,
              vssPortal: "https://prd311.wvoasis.gov/PRDVSS1X1ERP/Advantage4",
            },
          });

          if (opts.limit && out.length >= opts.limit) break;
        } catch (e) {
          warnings.push(`wv: ${cat.label} row parse failed: ${(e as Error).message}`);
        }
      }

      if (opts.limit && out.length >= opts.limit) break;
    }

    if (out.length === 0) warnings.push("wv: no open solicitations returned by wvOASIS");

    return {
      opportunities: opts.limit ? out.slice(0, opts.limit) : out,
      warnings,
      methodUsed: "json_api (apps.wvoasis.gov Bids.ashx POST, 3 category filters)",
    };
  },
};
