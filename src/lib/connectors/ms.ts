import * as cheerio from "cheerio";
import { fetchText } from "./http";
import { absolutize, clean, trimDescription, usDateToISO, TZ_OFFSET_MIN } from "./parse";
import type {
  Connector,
  ConnectorResult,
  ConnectorRunOptions,
  NormalizedOpportunity,
} from "@/lib/types";

/**
 * Mississippi DFA — plain Drupal CMS pages, no search app and no JSON API. The quirk
 * is that DFA has no single bid list: /bids-and-rfps-notices is a hub whose last four
 * accordion panels are just links out to four sibling CMS pages, each of which stores
 * its solicitations in a DIFFERENT hand-authored markup shape:
 *
 *   1. hub page  — <dd> prose where each solicitation is a <p>"RFx# 316… - Title"</p>
 *                  followed by a sibling <ul> of PDF attachments. The third <dt> panel
 *                  ("DFA Completed Procurements") must be skipped — same markup, dead bids.
 *   2. purchasing— <dt> IS the title; the <dd> is free prose and the due date is an
 *                  English sentence ("received at 2:00 p.m., Thursday, August 27, 2026"),
 *                  so usDateToISO (M/D/YYYY only) can't see it — hence monthNameToISO.
 *   3. construct.— <dd><li><span>Label:</span> value</li> pseudo-table (GS No / Project
 *                  Title / Using Agency / Date / RFx#). The page holds TWO <dl>s: the
 *                  first is live bids, the second is "BID TABS" (already opened), so we
 *                  take only the first.
 *   4. leases    — real <table>s; again two, and only the first ("Current Advertisements
 *                  for Lease Space") is open — the second is Notices of Intent to Award.
 *
 * All four are fetched independently and a failure in one is downgraded to a warning
 * rather than failing the run.
 */
const ORIGIN = "https://www.dfa.ms.gov";
const HUB_URL = `${ORIGIN}/bids-and-rfps-notices`;
const PURCHASING_URL = `${ORIGIN}/current-bids-and-proposals`;
const CONSTRUCTION_URL = `${ORIGIN}/construction-solicitations-bid-tabs`;
const LEASE_URL = `${ORIGIN}/real-property-management-solicitations`;

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

/**
 * Parse an English-prose deadline such as "2:00 p.m., Thursday, August 27, 2026" or
 * "by 3 pm CST August 31, 2026". Returns ISO (Central) or null. Time is optional and
 * may appear either before or after the date, so we scan for both independently.
 */
function monthNameToISO(input: string | null | undefined): string | null {
  const s = clean(input);
  if (!s) return null;
  const dm = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/i.exec(s);
  if (!dm) return null;
  const month = MONTHS[dm[1].toLowerCase()];
  const day = Number(dm[2]);
  const year = Number(dm[3]);

  let hour = 0;
  let minute = 0;
  const tm = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\.?/i.exec(s);
  if (tm) {
    hour = Number(tm[1]);
    minute = tm[2] ? Number(tm[2]) : 0;
    const pm = tm[3].toLowerCase() === "p";
    if (pm && hour < 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
  }

  const ms = Date.UTC(year, month, day, hour, minute) - TZ_OFFSET_MIN.CT * 60_000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Lowercase slug used as a last-resort stable externalId when no RFx#/GS# exists. */
function slugId(prefix: string, ...parts: string[]): string {
  const body = parts
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${prefix}-${body}`;
}

type Attachment = { filename: string; url: string };

/** Collect anchors inside a cheerio selection as attachment records. */
function collectAttachments(
  $: cheerio.CheerioAPI,
  scope: cheerio.Cheerio<never> | ReturnType<cheerio.CheerioAPI>,
  base: string,
): Attachment[] {
  const out: Attachment[] = [];
  const seen = new Set<string>();
  scope.find("a[href]").each((_, a) => {
    const href = clean($(a).attr("href"));
    if (!href || href.startsWith("mailto:") || href.startsWith("tel:")) return;
    const url = absolutize(base, href);
    if (!url || seen.has(url)) return;
    seen.add(url);
    const filename = clean($(a).text()) || decodeURIComponent(url.split("/").pop() ?? "attachment");
    out.push({ filename, url });
  });
  return out;
}

/** Infer a coarse site status from the names of the posted documents. */
function statusFromAttachments(atts: Attachment[]): string {
  const joined = atts.map((a) => a.filename).join(" | ").toLowerCase();
  if (/cancellation|cancelled|canceled/.test(joined)) return "Cancelled";
  if (/intent to award|notice of award/.test(joined)) return "Intent to Award Posted";
  if (/amendment/.test(joined)) return "Amended";
  return "Open";
}

/** 1. Hub page: <p>RFx# NNN - Title</p> + sibling <ul> of PDFs, inside live <dd> panels. */
function parseHub(html: string, warnings: string[]): NormalizedOpportunity[] {
  const $ = cheerio.load(html);
  const out: NormalizedOpportunity[] = [];

  $("dl.ckeditor-accordion > dt").each((_, dt) => {
    const panel = clean($(dt).text());
    // Same markup is reused for the archive panel — skip it.
    if (/completed/i.test(panel)) return;
    const dd = $(dt).next("dd");
    if (dd.length === 0) return;

    dd.find("p").each((__, p) => {
      try {
        const text = clean($(p).text());
        const m = /RFx\s*#?\s*(\d{6,})\s*[-–—]+\s*(.+)/i.exec(text);
        if (!m) return;
        const rfx = m[1];
        const title = clean(m[2]);
        if (!title) return;

        const list = $(p).next("ul, ol");
        const attachmentUrls = list.length > 0 ? collectAttachments($, list, HUB_URL) : [];

        out.push({
          externalId: `RFx-${rfx}`,
          title,
          agency: "Mississippi Department of Finance and Administration",
          category: panel || null,
          description: trimDescription(title),
          detailUrl: attachmentUrls[0]?.url ?? HUB_URL,
          statusOnSite: statusFromAttachments(attachmentUrls),
          attachmentUrls: attachmentUrls.length > 0 ? attachmentUrls : undefined,
          raw: { source: "hub", panel, rfx },
        });
      } catch (e) {
        warnings.push(`ms: hub row parse failed: ${(e as Error).message}`);
      }
    });
  });

  return out;
}

/** 2. Purchasing page: <dt> is the title, <dd> is prose carrying the RFP number + deadline. */
function parsePurchasing(html: string, warnings: string[]): NormalizedOpportunity[] {
  const $ = cheerio.load(html);
  const out: NormalizedOpportunity[] = [];

  $("dl.ckeditor-accordion > dt").each((_, dt) => {
    try {
      const title = clean($(dt).text());
      if (!title) return;
      const dd = $(dt).next("dd");
      if (dd.length === 0) return;

      const body = clean(dd.text());
      const num = /\bRF[PQXI]\s*#?\s*(\d{6,})/i.exec(body);
      const smart = /Smart\s+RFP\s*#?\s*([\w-]+)/i.exec(body);
      const attachmentUrls = collectAttachments($, dd, PURCHASING_URL);

      out.push({
        externalId: num ? `RFx-${num[1]}` : slugId("MSPURCH", title),
        title,
        agency: "MS DFA Office of Purchasing, Travel and Fleet Management",
        category: "Purchasing",
        description: trimDescription(body),
        dueDate: monthNameToISO(body),
        detailUrl: PURCHASING_URL,
        statusOnSite: "Open",
        attachmentUrls: attachmentUrls.length > 0 ? attachmentUrls : undefined,
        raw: { source: "purchasing", smartRfp: smart?.[1] ?? null },
      });
    } catch (e) {
      warnings.push(`ms: purchasing row parse failed: ${(e as Error).message}`);
    }
  });

  return out;
}

/** 3. Construction page: first <dl> only; each <li> is "<span>Label:</span> value". */
function parseConstruction(html: string, warnings: string[]): NormalizedOpportunity[] {
  const $ = cheerio.load(html);
  const out: NormalizedOpportunity[] = [];

  // The second <dl> on this page is BID TABS (already-opened bids) — live bids only.
  const liveList = $("dl.ckeditor-accordion").first();
  liveList.find("> dt").each((_, dt) => {
    try {
      const heading = clean($(dt).text());
      const dd = $(dt).next("dd");
      if (dd.length === 0) return;

      const fields: Record<string, string> = {};
      dd.find("li").each((__, li) => {
        const label = clean($(li).find("span").first().text()).replace(/:$/, "");
        if (!label) return;
        const value = clean($(li).text()).slice(label.length + 1).replace(/^[:\s]+/, "");
        fields[label.toLowerCase()] = clean(value);
      });

      const gsNo = fields["gs no"] || heading.replace(/^GS\s*/i, "");
      const rfx = fields["rfx#"] || fields["rfx"] || "";
      const title = fields["project title"] || heading;
      if (!gsNo && !rfx) return;

      const attachmentUrls = collectAttachments($, dd, CONSTRUCTION_URL);

      out.push({
        externalId: rfx ? `RFx-${rfx}` : `GS-${gsNo}`,
        title,
        agency: fields["using agency"] || "MS DFA Bureau of Building, Grounds and Real Property Management",
        category: "Construction",
        description: trimDescription(
          [title, fields["using agency"], fields["professional"] ? `Professional: ${fields["professional"]}` : ""]
            .filter(Boolean)
            .join(" — "),
        ),
        dueDate: usDateToISO(fields["date"], TZ_OFFSET_MIN.CT),
        detailUrl: attachmentUrls[0]?.url ?? CONSTRUCTION_URL,
        statusOnSite: "Open",
        attachmentUrls: attachmentUrls.length > 0 ? attachmentUrls : undefined,
        raw: { source: "construction", gsNo, rfx: rfx || null, professional: fields["professional"] ?? null },
      });
    } catch (e) {
      warnings.push(`ms: construction row parse failed: ${(e as Error).message}`);
    }
  });

  return out;
}

/** 4. Lease page: first <table> only (AGENCY / CITY, COUNTY / DEADLINE). */
function parseLeases(html: string, warnings: string[]): NormalizedOpportunity[] {
  const $ = cheerio.load(html);
  const out: NormalizedOpportunity[] = [];

  // The second table is "Notice of Intent to Award" — open advertisements only.
  const table = $("table.tblwdt").first();
  table.find("tbody tr").each((_, tr) => {
    try {
      const tds = $(tr).find("td");
      if (tds.length < 3) return;
      const agency = clean(tds.eq(0).text());
      const location = clean(tds.eq(1).text()).replace(/\s*\/\s*/g, ", ");
      const deadline = clean(tds.eq(2).text());
      if (!agency) return;

      const attachmentUrls = collectAttachments($, tds.eq(1), LEASE_URL);
      const title = `Request for Lease Proposals — ${agency}${location ? ` (${location})` : ""}`;

      out.push({
        externalId: slugId("MSLEASE", agency, location, deadline),
        title,
        agency,
        category: "Real Property / Lease",
        description: trimDescription(title),
        dueDate: usDateToISO(deadline, TZ_OFFSET_MIN.CT),
        detailUrl: attachmentUrls[0]?.url ?? LEASE_URL,
        statusOnSite: "Open",
        attachmentUrls: attachmentUrls.length > 0 ? attachmentUrls : undefined,
        raw: { source: "lease", location, deadlineText: deadline },
      });
    } catch (e) {
      warnings.push(`ms: lease row parse failed: ${(e as Error).message}`);
    }
  });

  return out;
}

interface Source {
  name: string;
  url: string;
  parse: (html: string, warnings: string[]) => NormalizedOpportunity[];
}

const SOURCES: Source[] = [
  { name: "hub", url: HUB_URL, parse: parseHub },
  { name: "purchasing", url: PURCHASING_URL, parse: parsePurchasing },
  { name: "construction", url: CONSTRUCTION_URL, parse: parseConstruction },
  { name: "lease", url: LEASE_URL, parse: parseLeases },
];

export const msConnector: Connector = {
  key: "ms",
  label: "Mississippi DFA",
  async fetchOpenOpportunities(opts: ConnectorRunOptions = {}): Promise<ConnectorResult> {
    const warnings: string[] = [];
    const collected: NormalizedOpportunity[] = [];

    for (const source of SOURCES) {
      if (opts.signal?.aborted) {
        warnings.push(`ms: aborted before fetching ${source.name}`);
        break;
      }
      try {
        const html = await fetchText(source.url, { signal: opts.signal });
        const rows = source.parse(html, warnings);
        if (rows.length === 0) warnings.push(`ms: ${source.name} page returned no rows`);
        collected.push(...rows);
      } catch (e) {
        warnings.push(`ms: ${source.name} fetch failed (${source.url}): ${(e as Error).message}`);
      }
    }

    // The same RFx# can appear on both the hub and the construction page; first wins,
    // but merge in attachments the later copy carries.
    const byId = new Map<string, NormalizedOpportunity>();
    for (const o of collected) {
      const existing = byId.get(o.externalId);
      if (!existing) {
        byId.set(o.externalId, o);
        continue;
      }
      if (!existing.dueDate && o.dueDate) existing.dueDate = o.dueDate;
      const merged = [...(existing.attachmentUrls ?? []), ...(o.attachmentUrls ?? [])];
      const seen = new Set<string>();
      const deduped = merged.filter((a) => (seen.has(a.url) ? false : (seen.add(a.url), true)));
      if (deduped.length > 0) existing.attachmentUrls = deduped;
    }

    const opportunities = [...byId.values()];
    return {
      opportunities: opts.limit ? opportunities.slice(0, opts.limit) : opportunities,
      warnings,
      methodUsed: "static_html (cheerio, 4 Drupal CMS pages)",
    };
  },
};
