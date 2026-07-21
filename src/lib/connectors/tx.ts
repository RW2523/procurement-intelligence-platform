import { fetchJson, request, sleep } from "./http";
import { clean, trimDescription, usDateToISO, TZ_OFFSET_MIN } from "./parse";
import type {
  Connector,
  ConnectorResult,
  ConnectorRunOptions,
  NormalizedOpportunity,
} from "@/lib/types";

/**
 * Texas ESBD (txsmartbuy.gov) — a NetSuite SuiteCommerce site. The /esbd page IS
 * server-rendered, but its filters are inert over GET (`?status=1` returns the exact
 * same bytes as no query at all), so scraping it means walking all 2,426 pages of
 * 58k historical records to find the ~800 open ones.
 *
 * The Backbone app behind it talks to a real JSON service published under the CPA
 * extension's asset path:
 *   POST /app/extensions/CPA/CPAMain/1.0.0/services/ESBD.Service.ss
 * It rejects GET with ERR_METHOD_NOT_ALLOWED — the filter payload must be POSTed as
 * JSON. `status: "1"` is the portal's "open" bucket and covers both `Posted` (1) and
 * `Addendum Posted` (6). Every response also echoes the full ~3,000-entry agency
 * dropdown, which we discard.
 *
 * Detail records (description, estimated value, attachments, buyer contact) come from
 * a sibling service that DOES accept GET, keyed by solicitation id via the oddly named
 * `identification` param:
 *   GET .../services/ESBD.Details.Service.ss?identification=<id>&urlRoot=esbd
 * The human-facing /esbd/<id> page is a JS shell with no data in it, so this service is
 * the only HTTP-reachable source for those fields. Enrichment is best-effort and capped.
 */

const ORIGIN = "https://www.txsmartbuy.gov";
const SVC_BASE = `${ORIGIN}/app/extensions/CPA/CPAMain/1.0.0/services`;
const LIST_SVC = `${SVC_BASE}/ESBD.Service.ss`;
const DETAIL_SVC = `${SVC_BASE}/ESBD.Details.Service.ss`;

/** Portal status id for open solicitations (returns both "Posted" and "Addendum Posted"). */
const STATUS_OPEN = "1";
const PAGE_SIZE_FALLBACK = 24;
const MAX_PAGES = 40;
const MAX_ENRICH = 60;

interface EsbdLine {
  internalid?: string;
  title?: string;
  solicitationId?: string;
  responseDue?: string;
  responseTime?: string;
  agencyNumber?: string;
  agencyName?: string;
  status?: string;
  statusName?: string;
  postingDate?: string;
  cancelledDate?: string;
  created?: string;
  lastModified?: string;
  nigpCodes?: string;
  repostURL?: string;
  url?: string;
}

interface EsbdListResponse {
  lines?: EsbdLine[];
  page?: number;
  recordsPerPage?: number;
  totalRecordsFound?: number;
}

interface EsbdAttachment {
  fileId?: string;
  fileName?: string;
  fileURL?: string;
  fileDescription?: string;
}

interface EsbdDetail {
  description?: string;
  value?: string;
  contactName?: string;
  contactNumber?: string;
  contactEmail?: string;
  bidResponseEmail?: string;
  bidResponseURL?: string;
  addendum?: string;
  postingRequirementText?: string;
  attachments?: EsbdAttachment[];
}

/** The description field is stored as Word-flavoured HTML; flatten it to text. */
function htmlToText(html: string | undefined): string | null {
  if (!html) return null;
  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return trimDescription(text);
}

/**
 * "92416-Course Development Services...;\n93856-Hospital..." -> the numeric codes.
 * These are NIGP class/item codes, NOT NAICS — they stay in `raw`, and `naicsCode` is
 * left null rather than being populated with a code from the wrong taxonomy.
 */
function nigpCodeList(nigp: string | undefined): string[] {
  return (clean(nigp ?? "").match(/\d{5}(?=\s*-)/g) ?? []);
}

function nigpLabels(nigp: string | undefined): string | null {
  const parts = clean(nigp ?? "")
    .split(";")
    .map((p) => clean(p).replace(/^\d{5}\s*-\s*/, ""))
    .filter(Boolean);
  return parts.length ? parts.join("; ") : null;
}

async function postList(page: number, opts: ConnectorRunOptions): Promise<EsbdListResponse> {
  return fetchJson<EsbdListResponse>(LIST_SVC, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ status: STATUS_OPEN, page }),
    signal: opts.signal,
  });
}

export const txConnector: Connector = {
  key: "tx",
  label: "Texas ESBD",
  async fetchOpenOpportunities(opts: ConnectorRunOptions = {}): Promise<ConnectorResult> {
    const warnings: string[] = [];
    const out: NormalizedOpportunity[] = [];
    const seen = new Set<string>();

    const target = opts.limit && opts.limit > 0 ? opts.limit : Infinity;
    let totalRecords = Infinity;

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (opts.signal?.aborted) break;
      if (out.length >= target) break;

      let body: EsbdListResponse;
      try {
        body = await postList(page, opts);
      } catch (e) {
        warnings.push(`list page ${page} failed: ${(e as Error).message}`);
        break;
      }

      const lines = body.lines ?? [];
      if (typeof body.totalRecordsFound === "number") totalRecords = body.totalRecordsFound;
      if (lines.length === 0) break;

      for (const line of lines) {
        try {
          const externalId = clean(line.solicitationId ?? "");
          if (!externalId || seen.has(externalId)) continue;
          seen.add(externalId);

          // responseDue is "M/D/YYYY" and responseTime "4:00 PM" in separate fields.
          const dueRaw = [clean(line.responseDue ?? ""), clean(line.responseTime ?? "")]
            .filter(Boolean)
            .join(" ");

          out.push({
            externalId,
            title: clean(line.title ?? "") || externalId,
            agency: clean(line.agencyName ?? "") || null,
            category: nigpLabels(line.nigpCodes),
            naicsCode: null,
            postedDate: usDateToISO(line.postingDate, TZ_OFFSET_MIN.CT),
            dueDate: usDateToISO(dueRaw, TZ_OFFSET_MIN.CT),
            detailUrl: `${ORIGIN}/esbd/${encodeURIComponent(externalId)}`,
            statusOnSite: clean(line.statusName ?? "") || null,
            raw: {
              internalid: line.internalid ?? null,
              agencyNumber: line.agencyNumber ?? null,
              statusId: line.status ?? null,
              nigpCodes: clean(line.nigpCodes ?? "") || null,
              nigpCodeList: nigpCodeList(line.nigpCodes),
              created: line.created ?? null,
              lastModified: line.lastModified ?? null,
              repostURL: line.repostURL || null,
            },
          });
        } catch (e) {
          warnings.push(`row parse failed on page ${page}: ${(e as Error).message}`);
        }
      }

      const perPage = body.recordsPerPage ?? PAGE_SIZE_FALLBACK;
      if (page * perPage >= totalRecords) break;
      await sleep(250);
    }

    const opportunities = out.slice(0, opts.limit && opts.limit > 0 ? opts.limit : out.length);

    // Best-effort enrichment: description / estimated value / attachments live only in
    // the details service. One request per record, so cap it and never fail the run.
    const enrichCount = Math.min(opportunities.length, MAX_ENRICH);
    let enriched = 0;
    for (let i = 0; i < enrichCount; i++) {
      if (opts.signal?.aborted) break;
      const o = opportunities[i];
      try {
        const url =
          `${DETAIL_SVC}?identification=${encodeURIComponent(o.externalId)}&urlRoot=esbd`;
        const r = await request(url, {
          headers: { Accept: "application/json" },
          signal: opts.signal,
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = JSON.parse(r.text) as EsbdDetail;

        o.description = htmlToText(d.description);

        const value = Number.parseFloat(clean(d.value ?? ""));
        o.estimatedValue = Number.isFinite(value) && value > 0 ? value : null;

        const attachments = (d.attachments ?? [])
          .filter((a) => a.fileURL && a.fileName)
          .map((a) => ({
            filename: clean(a.fileName as string),
            url: (a.fileURL as string).startsWith("http")
              ? (a.fileURL as string)
              : `${ORIGIN}${a.fileURL}`,
          }));
        if (attachments.length) o.attachmentUrls = attachments;

        o.raw = {
          ...o.raw,
          contactName: clean(d.contactName ?? "") || null,
          contactEmail: clean(d.contactEmail ?? "") || null,
          contactNumber: clean(d.contactNumber ?? "") || null,
          bidResponseEmail: d.bidResponseEmail || null,
          bidResponseURL: d.bidResponseURL || null,
          addendum: htmlToText(d.addendum),
          postingRequirement: clean(d.postingRequirementText ?? "") || null,
        };
        enriched++;
      } catch (e) {
        warnings.push(`detail fetch failed for ${o.externalId}: ${(e as Error).message}`);
      }
      await sleep(150);
    }

    if (enrichCount < opportunities.length) {
      warnings.push(
        `enriched ${enriched}/${opportunities.length} records (detail fetch capped at ${MAX_ENRICH})`,
      );
    }

    return {
      opportunities,
      warnings,
      methodUsed: "json_api (POST ESBD.Service.ss + GET ESBD.Details.Service.ss)",
    };
  },
};
