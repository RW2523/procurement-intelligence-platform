import * as cheerio from "cheerio";
import { CookieJar, request, sleep } from "./http";
import { msDateToISO, trimDescription, usDateToISO } from "./parse";
import type {
  Connector,
  ConnectorResult,
  ConnectorRunOptions,
  NormalizedOpportunity,
} from "@/lib/types";

/**
 * North Carolina eVP — Microsoft Power Pages / Dataverse entity grid (JSON API).
 * Flow: GET list page (cookies + grid config) → GET token → POST entity-grid-data.json.
 * No headless browser required.
 */
const BASE = "https://evp.nc.gov";
const LIST_PAGE = `${BASE}/solicitations/?status=0`;
const TOKEN_URL = `${BASE}/_layout/tokenhtml`;
const FALLBACK_GET_URL = "/_services/entity-grid-data.json/863ea987-6d3e-ed11-9daf-001dd805ec0b";

interface DvAttr {
  Name: string;
  Value: unknown;
  DisplayValue?: string | null;
  FormattedValue?: string | null;
}
interface DvRecord {
  Id: string;
  EntityName: string;
  Attributes: DvAttr[];
}
interface DvResponse {
  Records: DvRecord[];
  MoreRecords: boolean;
  PageCount: number;
  PageNumber: number;
}

const attr = (rec: DvRecord, name: string) => rec.Attributes.find((a) => a.Name === name);
function disp(rec: DvRecord, name: string): string | null {
  const a = attr(rec, name);
  if (!a) return null;
  return a.DisplayValue ?? a.FormattedValue ?? (typeof a.Value === "string" ? a.Value : null);
}
function dvDate(rec: DvRecord, name: string): string | null {
  const a = attr(rec, name);
  if (!a) return null;
  if (typeof a.Value === "string") {
    const iso = msDateToISO(a.Value);
    if (iso) return iso;
  }
  if (typeof a.Value === "number") {
    const d = new Date(a.Value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return a.DisplayValue ? usDateToISO(a.DisplayValue) : null;
}

function decodeLayouts(val: string): Record<string, unknown>[] | null {
  for (const candidate of [() => Buffer.from(val, "base64").toString("utf8"), () => val]) {
    try {
      const parsed = JSON.parse(candidate());
      if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
    } catch {
      /* try next */
    }
  }
  return null;
}

async function getToken(jar: CookieJar): Promise<string> {
  const { text } = await request(TOKEN_URL, { jar });
  const $ = cheerio.load(text);
  const fromInput = $('input[name="__RequestVerificationToken"]').attr("value");
  if (fromInput) return fromInput;
  const m = /value="([^"]{40,})"/.exec(text);
  return m?.[1] ?? "";
}

export const ncConnector: Connector = {
  key: "nc",
  label: "North Carolina eVP",
  async fetchOpenOpportunities(opts: ConnectorRunOptions = {}): Promise<ConnectorResult> {
    const warnings: string[] = [];
    const jar = new CookieJar();

    // 1. Seed page → cookies + grid config.
    const seed = await request(LIST_PAGE, { jar, signal: opts.signal });
    if (!seed.ok) throw new Error(`NC seed page HTTP ${seed.status}`);
    const $ = cheerio.load(seed.text);
    const grid = $("div.entity-grid").first();
    const getUrl = grid.attr("data-get-url") || FALLBACK_GET_URL;
    const layoutsRaw = grid.attr("data-view-layouts") || "";
    const layouts = decodeLayouts(layoutsRaw);
    const layout = layouts?.[0] as { Base64SecureConfiguration?: string; SortExpression?: string } | undefined;
    const secureConfig = layout?.Base64SecureConfiguration;
    const sortExpression = layout?.SortExpression || "evp_posteddate DESC";
    if (!secureConfig) {
      throw new Error("NC: could not extract Base64SecureConfiguration from grid layout");
    }

    // 2. Anti-forgery token.
    let token = await getToken(jar);

    // 3. Paginated POST.
    const all: NormalizedOpportunity[] = [];
    const pageSize = 100;
    const maxPages = opts.limit ? 1 : 25;
    for (let page = 1; page <= maxPages; page++) {
      const body = JSON.stringify({
        base64SecureConfiguration: secureConfig,
        sortExpression,
        search: null,
        page,
        pageSize,
        filter: null,
        metaFilter: null,
        timezoneOffset: 0,
        customParameters: [],
      });
      let r = await request(`${BASE}${getUrl}`, {
        method: "POST",
        jar,
        signal: opts.signal,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          __RequestVerificationToken: token,
          "X-Requested-With": "XMLHttpRequest",
          Accept: "application/json, text/javascript, */*; q=0.01",
          Referer: LIST_PAGE,
        },
        body,
      });
      // Token/cookie expiry → refresh once and retry.
      if (r.status === 500 || r.status === 403) {
        token = await getToken(jar);
        r = await request(`${BASE}${getUrl}`, {
          method: "POST",
          jar,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            __RequestVerificationToken: token,
            "X-Requested-With": "XMLHttpRequest",
            Accept: "application/json, text/javascript, */*; q=0.01",
            Referer: LIST_PAGE,
          },
          body,
        });
      }
      if (!r.ok) {
        warnings.push(`NC page ${page} HTTP ${r.status}`);
        break;
      }
      let data: DvResponse;
      try {
        data = JSON.parse(r.text);
      } catch {
        warnings.push(`NC page ${page}: non-JSON response`);
        break;
      }
      for (const rec of data.Records ?? []) {
        all.push({
          externalId: disp(rec, "evp_solicitationnbr") || rec.Id,
          title: disp(rec, "evp_name") || "(untitled)",
          agency: disp(rec, "owningbusinessunit"),
          description: trimDescription(disp(rec, "evp_description")),
          postedDate: dvDate(rec, "evp_posteddate"),
          dueDate: dvDate(rec, "evp_opendate"),
          detailUrl: `${BASE}/solicitations/details/?id=${rec.Id}`,
          statusOnSite: disp(rec, "statuscode"),
          raw: { guid: rec.Id },
        });
      }
      if (!data.MoreRecords || opts.limit) break;
      await sleep(1200);
    }

    return { opportunities: all, warnings, methodUsed: "json_api (Dataverse entity-grid)" };
  },
};
