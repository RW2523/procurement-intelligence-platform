import { fetchJson } from "./http";
import { clean, trimDescription, TZ_OFFSET_MIN } from "./parse";
import type {
  Connector,
  ConnectorResult,
  ConnectorRunOptions,
  NormalizedOpportunity,
} from "@/lib/types";

/**
 * South Dakota — the documented entry point (sd.gov ServiceNow KB article
 * KB0044787) is a dead end over plain HTTP. Every sd.gov path, including the
 * legacy `/kb_view.do?sysparm_article=...` form, returns the same ~615 KB
 * Angular Service Portal shell with no article body, and the ServiceNow REST
 * APIs that would serve the text (`/api/sn_km_api/knowledge/articles/...`,
 * `/api/now/table/kb_knowledge`) all 401 for anonymous callers. So the KB
 * article cannot be used to discover the bid list at runtime.
 *
 * The list it points a human to is the state's ESM Solutions posting board.
 * That board is also an Angular SPA, but is backed by a clean, unauthenticated
 * JSON API:
 *
 *   GET https://postingboard.esmsolutions.com/api/postingBoard/{uid}/currentevents
 *       ?pageNo=0&recordsPerPage=100
 *       &browserGlobalTimeZoneNameId=...&browserGlobalTimeZoneName=...&browserOffset=...
 *
 * `{uid}` is South Dakota's ESM tenant GUID, hardcoded below. Because the KB
 * article is unreadable anonymously, the GUID could not be re-derived from
 * sd.gov; it was confirmed empirically instead — the endpoint returns
 * unmistakably South Dakota solicitations (SDSU, USD, "Mitchell, SD",
 * Keystone). If SD ever re-tenants, this connector goes silent rather than
 * wrong, and TENANT_UID must be re-sourced by hand from the posting board URL.
 * The browser* timezone params are always sent by the SPA, so we mirror them.
 *
 * Quirks:
 *  - Dates come back as NAIVE local wall-clock (`2026-07-22T11:00:00`) with a
 *    separate `timezoneNameAbbreviation` ("CT"). We attach the offset ourselves.
 *  - `eventId` is an internal numeric key; `id` is the human solicitation number
 *    ("26RFP-SDSU06252026"). We use `id` as externalId and keep eventId in raw.
 *  - The per-event detail endpoints (headereventdetails/generaleventdetails/
 *    eventdocuments) return 404 for anonymous callers on this tenant, so the
 *    grid payload is all we can get without a supplier login. No description,
 *    NAICS, or attachments are available.
 */

const TENANT_UID = "3444a404-3818-494f-84c5-2a850acd7779";
const API_BASE = `https://postingboard.esmsolutions.com/api/postingBoard/${TENANT_UID}`;
const BOARD_BASE = `https://postingboard.esmsolutions.com/${TENANT_UID}`;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

/** The SPA always appends these; the API rejects nothing but we mirror it exactly. */
const TZ_PARAMS =
  "browserGlobalTimeZoneNameId=Central%20Standard%20Time" +
  "&browserGlobalTimeZoneName=America%2FChicago" +
  "&browserOffset=-360";

interface EsmLookup {
  id?: number;
  description?: string;
}

interface EsmEvent {
  eventId?: number | string;
  id?: string;
  eventName?: string;
  publishedDate?: string | null;
  eventDueDate?: string | null;
  daysLeft?: number | null;
  timezoneName?: string | null;
  timezoneNameAbbreviation?: string | null;
  invitationType?: EsmLookup | null;
  status?: EsmLookup | null;
}

interface EsmGridResponse {
  data?: EsmEvent[];
  totalCount?: number;
}

/**
 * ESM returns naive local wall-clock ("2026-07-22T11:00:00") plus a tz
 * abbreviation. Re-interpret it at that zone's offset and emit real UTC ISO.
 */
function naiveLocalToISO(value: string | null | undefined, tzAbbr?: string | null): string | null {
  const s = clean(value);
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!m) return null;
  const key = (tzAbbr ?? "CT").toUpperCase() as keyof typeof TZ_OFFSET_MIN;
  const offsetMinutes = TZ_OFFSET_MIN[key] ?? TZ_OFFSET_MIN.CT;
  const utcMs =
    Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      m[4] ? Number(m[4]) : 0,
      m[5] ? Number(m[5]) : 0,
      m[6] ? Number(m[6]) : 0,
    ) -
    offsetMinutes * 60_000;
  const d = new Date(utcMs);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Solicitation numbers encode the vehicle type: 26RFP..., 26IFB..., 26RFQ... */
function categoryFromId(id: string): string | null {
  const m = /\d{0,2}(RFP|IFB|RFQ|RFI|IFQ|BID)/i.exec(id);
  return m ? m[1].toUpperCase() : null;
}

export const sdConnector: Connector = {
  key: "sd",
  label: "South Dakota",
  async fetchOpenOpportunities(opts: ConnectorRunOptions = {}): Promise<ConnectorResult> {
    const warnings: string[] = [];
    const out: NormalizedOpportunity[] = [];
    const seen = new Set<string>();

    let totalCount = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url =
        `${API_BASE}/currentevents?pageNo=${page}&recordsPerPage=${PAGE_SIZE}&${TZ_PARAMS}`;

      let body: EsmGridResponse;
      try {
        body = await fetchJson<EsmGridResponse>(url, {
          signal: opts.signal,
          headers: { Accept: "application/json" },
        });
      } catch (e) {
        warnings.push(`currentevents page ${page} failed: ${(e as Error).message}`);
        break;
      }

      const rows = Array.isArray(body.data) ? body.data : [];
      if (typeof body.totalCount === "number") totalCount = body.totalCount;
      if (rows.length === 0) break;

      for (const row of rows) {
        try {
          const externalId = clean(row.id) || clean(String(row.eventId ?? ""));
          const title = clean(row.eventName);
          if (!externalId || !title) {
            warnings.push(`skipped row without id/name (eventId=${String(row.eventId)})`);
            continue;
          }
          if (seen.has(externalId)) continue;
          seen.add(externalId);

          const tz = row.timezoneNameAbbreviation ?? row.timezoneName ?? "CT";
          const eventKey = row.eventId != null ? String(row.eventId) : null;

          out.push({
            externalId,
            title,
            agency: "State of South Dakota",
            category: categoryFromId(externalId),
            description: trimDescription(title),
            postedDate: naiveLocalToISO(row.publishedDate, tz),
            dueDate: naiveLocalToISO(row.eventDueDate, tz),
            detailUrl: eventKey ? `${BOARD_BASE}/eventDetail?eventId=${eventKey}` : `${BOARD_BASE}/events`,
            statusOnSite: clean(row.status?.description) || null,
            raw: {
              eventId: row.eventId ?? null,
              daysLeft: row.daysLeft ?? null,
              timezoneName: row.timezoneName ?? null,
              invitationType: row.invitationType?.description ?? null,
              publishedDateLocal: row.publishedDate ?? null,
              eventDueDateLocal: row.eventDueDate ?? null,
            },
          });
        } catch (e) {
          warnings.push(`row parse failed (eventId=${String(row.eventId)}): ${(e as Error).message}`);
        }
      }

      if (opts.limit && out.length >= opts.limit) break;
      if (totalCount && out.length >= totalCount) break;
      if (rows.length < PAGE_SIZE) break;
    }

    if (out.length === 0) warnings.push("ESM posting board returned no open events");

    return {
      opportunities: opts.limit ? out.slice(0, opts.limit) : out,
      warnings,
      methodUsed: "json_api (ESM Solutions posting board /api/postingBoard/{uid}/currentevents)",
    };
  },
};
