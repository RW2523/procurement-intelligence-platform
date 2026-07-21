import { fetchJson } from "./http";
import { absolutize, clean, trimDescription } from "./parse";
import type {
  Connector,
  ConnectorResult,
  ConnectorRunOptions,
  NormalizedOpportunity,
} from "@/lib/types";

/**
 * Missouri (MissouriBUYS) runs on Oracle Fusion Cloud Redwood. The public page at
 * /fscmUI/redwood/negotiation-abstracts/view/abstractlisting is an empty Oracle JET SPA
 * shell — the served HTML contains only CDN bundle preloads and a `window.faConfig`
 * blob, no solicitation markup — so there is nothing to scrape there.
 *
 * The data comes from Oracle's `supplierNegotiationAbstracts` REST resource, which is
 * readable ANONYMOUSLY (no auth header at all). Three quirks matter:
 *
 *   1. It refuses a bare collection GET ("A finder is required to execute this
 *      operation"). You must pass the `RowFinderByBU` finder with the same
 *      ProcurementBUId the UI carries in its ?prcBuId= query param.
 *   2. String literals in `q=` must be SINGLE-quoted. Double quotes or a bare
 *      timestamp both yield an error payload with no totalResults.
 *   3. `attachments` under `expand=` is a nested COLLECTION object
 *      (`{items, count, hasMore, ...}`), not a bare array.
 *
 * Status alone does not mean "open". This BU currently exposes 52 ACTIVE and 1043
 * AMENDED abstracts, but AMENDED is a terminal-looking label Missouri keeps forever:
 * only ~10 AMENDED rows are still accepting bids, the rest closed as far back as 2024.
 * So we filter on `CloseDate > now` in addition to status — that yields the 62 genuinely
 * open rows. Filtering by status alone plus `orderBy=CloseDate:asc` would return the
 * OLDEST expired records first, i.e. an opts.limit page of pure garbage.
 *
 * `expand=attachments` returns pre-signed FileUrls carrying an XFND_EXPIRES stamp; those
 * signatures expire, so they are only useful if downloaded promptly after the run.
 */

const ORIGIN = "https://ewqg.fa.us8.oraclecloud.com";
const REST_BASE = `${ORIGIN}/fscmRestApi/resources/11.13.18.05/supplierNegotiationAbstracts`;
const PRC_BU_ID = "300000005255687";
const LIST_URL = `${ORIGIN}/fscmUI/redwood/negotiation-abstracts/view/abstractlisting?prcBuId=${PRC_BU_ID}`;
/** Open set is ~62 rows; 500 keeps it to a single request with headroom. */
const PAGE_LIMIT = 500;
const MAX_PAGES = 10;

interface OracleAttachment {
  FileName?: string | null;
  Title?: string | null;
  FileUrl?: string | null;
  DatatypeCode?: string | null;
}

/** Oracle nests expanded child collections rather than inlining an array. */
interface OracleChildCollection<T> {
  items?: T[] | null;
}

interface OracleAbstract {
  AuctionHeaderId?: number | null;
  Negotiation?: string | null;
  NegotiationTitle?: string | null;
  NegotiationType?: string | null;
  ProcurementBUName?: string | null;
  Synopsis?: string | null;
  AmendmentDescription?: string | null;
  NegotiationStatus?: string | null;
  NegotiationStatusCode?: string | null;
  CloseDate?: string | null;
  OpenDate?: string | null;
  PostingDate?: string | null;
  PublishDate?: string | null;
  PreviewDate?: string | null;
  BuyerName?: string | null;
  BuyerEmailAddress?: string | null;
  AttachmentsCount?: number | null;
  attachments?: OracleChildCollection<OracleAttachment> | null;
}

interface OracleCollection {
  items?: OracleAbstract[];
  count?: number;
  hasMore?: boolean;
  totalResults?: number;
}

/** Oracle hands back "2026-07-22T19:00:00+00:00" / "2026-06-26"; normalize to ISO UTC. */
function toISO(v: string | null | undefined): string | null {
  const s = clean(v);
  if (!s) return null;
  // Date-only values (PostingDate) are already plain ISO dates; keep them as-is.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function buildUrl(offset: number, nowISO: string): string {
  const qs = new URLSearchParams({
    finder: `RowFinderByBU;ProcurementBUId=${PRC_BU_ID}`,
    // Single quotes are mandatory; see quirk (2) above.
    q: `(NegotiationStatusCode='ACTIVE' or NegotiationStatusCode='AMENDED') and CloseDate>'${nowISO}'`,
    orderBy: "CloseDate:asc",
    expand: "attachments",
    onlyData: "true",
    totalResults: "true",
    limit: String(PAGE_LIMIT),
    offset: String(offset),
  });
  return `${REST_BASE}?${qs.toString()}`;
}

function mapAttachments(
  child: OracleChildCollection<OracleAttachment> | null | undefined,
): { filename: string; url: string }[] | undefined {
  const rows = child?.items;
  if (!rows?.length) return undefined;
  const out: { filename: string; url: string }[] = [];
  for (const a of rows) {
    const url = absolutize(ORIGIN, a.FileUrl);
    const filename = clean(a.FileName) || clean(a.Title);
    if (url && filename) out.push({ filename, url });
  }
  return out.length ? out : undefined;
}

export const moConnector: Connector = {
  key: "mo",
  label: "Missouri (Oracle Fusion)",
  async fetchOpenOpportunities(opts: ConnectorRunOptions = {}): Promise<ConnectorResult> {
    const warnings: string[] = [];
    const out: NormalizedOpportunity[] = [];
    const seen = new Set<string>();
    // Oracle compares in UTC; trim the milliseconds it does not accept in q=.
    const nowISO = new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");

    let offset = 0;
    // Guard against a runaway cursor if hasMore ever sticks true.
    for (let page = 0; page < MAX_PAGES; page++) {
      if (opts.signal?.aborted) break;

      const body = await fetchJson<OracleCollection>(buildUrl(offset, nowISO), {
        headers: { Accept: "application/json", "REST-Framework-Version": "4" },
        signal: opts.signal,
      });
      const items = body.items ?? [];
      if (!items.length) break;

      for (const it of items) {
        try {
          const externalId = clean(it.Negotiation) || String(it.AuctionHeaderId ?? "");
          if (!externalId || seen.has(externalId)) continue;
          seen.add(externalId);

          const amendment = clean(it.AmendmentDescription);
          const synopsis = clean(it.Synopsis);
          const description = [synopsis, amendment ? `Amendment: ${amendment}` : ""]
            .filter(Boolean)
            .join(" — ");

          out.push({
            externalId,
            title: clean(it.NegotiationTitle) || externalId,
            agency: clean(it.ProcurementBUName) || null,
            category: clean(it.NegotiationType) || null,
            naicsCode: null,
            description: trimDescription(description),
            postedDate: toISO(it.PostingDate) ?? toISO(it.PublishDate),
            dueDate: toISO(it.CloseDate),
            qAndADeadline: null,
            estimatedValue: null,
            // Every /fscmUI/redwood/* route serves the same SPA shell, so no verifiable
            // per-record deep link exists; point at the real listing page and keep the
            // AuctionHeaderId in raw for downstream use.
            detailUrl: LIST_URL,
            statusOnSite: clean(it.NegotiationStatus) || null,
            attachmentUrls: mapAttachments(it.attachments),
            raw: {
              auctionHeaderId: it.AuctionHeaderId ?? null,
              procurementBuId: PRC_BU_ID,
              negotiationStatusCode: clean(it.NegotiationStatusCode) || null,
              openDate: toISO(it.OpenDate),
              previewDate: toISO(it.PreviewDate),
              buyerName: clean(it.BuyerName) || null,
              buyerEmail: clean(it.BuyerEmailAddress) || null,
              attachmentsCount: it.AttachmentsCount ?? 0,
            },
          });
        } catch (e) {
          warnings.push(
            `mo: failed to parse abstract ${it.Negotiation ?? it.AuctionHeaderId ?? "<unknown>"}: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
      }

      if (!body.hasMore) break;
      offset += items.length;
      if (opts.limit && out.length >= opts.limit) break;
    }

    if (!out.length) {
      warnings.push("mo: Oracle returned no open ACTIVE/AMENDED negotiation abstracts for this BU.");
    }

    return {
      opportunities: opts.limit ? out.slice(0, opts.limit) : out,
      warnings,
      methodUsed:
        "json_api (Oracle Fusion supplierNegotiationAbstracts REST, RowFinderByBU, anonymous)",
    };
  },
};
