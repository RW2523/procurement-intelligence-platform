import * as cheerio from "cheerio";
import { fetchJson, sleep } from "./http";
import { clean, trimDescription } from "./parse";
import type {
  Connector,
  ConnectorResult,
  ConnectorRunOptions,
  NormalizedOpportunity,
} from "@/lib/types";

/**
 * City of Phoenix — OpenGov Procurement (ex-ProcureNow) portal.
 *
 * Quirk: https://procurement.opengov.com/portal/phoenix is a React SPA sitting
 * behind a Cloudflare JS challenge (plain GET -> HTTP 403 "Just a moment..."),
 * so the portal HTML is unscrapeable. The SPA's own data, however, comes from a
 * SEPARATE, unchallenged JSON API host: api.procurement.opengov.com/api/v1.
 * Two endpoints (both public, no auth token required):
 *   POST /project/list  {governmentCode}  -> every project for the government
 *   GET  /project/:id                     -> summary HTML, NIGP categories, attachments
 *
 * The list endpoint returns ALL lifecycle states, so we filter to the ones a
 * bidder can still act on ("open", plus "comingSoon" pre-releases). Detail
 * hydration is best-effort and rate-limited; a failed detail never drops a row.
 *
 * Attachment URLs are pre-signed S3 links with a ~20h expiry — treat as ephemeral.
 */
const API_BASE = "https://api.procurement.opengov.com/api/v1";
const GOVERNMENT_CODE = "phoenix";
const PORTAL_BASE = "https://procurement.opengov.com/portal/phoenix";
const DETAIL_CONCURRENCY_DELAY_MS = 150;
const MAX_DETAIL_FETCHES = 40;

/** Statuses that still represent a live bidding opportunity. */
const LIVE_STATUSES = new Set(["open"]);

interface PhxListProject {
  id: number;
  title: string | null;
  status: string | null;
  financialId: string | null;
  departmentName: string | null;
  postedAt: string | null;
  postScheduledAt: string | null;
  proposalDeadline: string | null;
  preProposalDate: string | null;
  qaDeadline: string | null;
  qaResponseDeadline: string | null;
  comingSoon: boolean;
  isPrivate: boolean;
  type: string | null;
  government_id: number;
  contactFirstName: string | null;
  contactLastName: string | null;
  template?: { title?: string | null; processAcronym?: string | null } | null;
}

interface PhxListResponse {
  projects: PhxListProject[];
  count?: number;
}

interface PhxCategory {
  code?: string | null;
  title?: string | null;
}

interface PhxAttachment {
  filename?: string | null;
  title?: string | null;
  url?: string | null;
}

interface PhxDetail {
  summary?: string | null;
  background?: string | null;
  categories?: PhxCategory[] | null;
  attachments?: PhxAttachment[] | null;
  contactEmail?: string | null;
  preProposalLocation?: string | null;
}

const JSON_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "Content-Type": "application/json",
  Origin: "https://procurement.opengov.com",
  Referer: PORTAL_BASE,
};

/** OpenGov stores rich text as HTML; flatten it to readable plain text. */
function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null;
  const $ = cheerio.load(`<div id="r">${html}</div>`);
  $("#r br").replaceWith("\n");
  $("#r p, #r div, #r li").append("\n");
  return trimDescription(clean($("#r").text().replace(/\n{2,}/g, "\n")));
}

/** ISO-8601 already; normalise to null when absent/blank. */
function isoOrNull(v: string | null | undefined): string | null {
  const s = clean(v ?? "");
  return s ? s : null;
}

export const phxConnector: Connector = {
  key: "phx",
  label: "Phoenix (OpenGov)",
  async fetchOpenOpportunities(opts: ConnectorRunOptions = {}): Promise<ConnectorResult> {
    const warnings: string[] = [];

    const list = await fetchJson<PhxListResponse>(`${API_BASE}/project/list`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        governmentCode: GOVERNMENT_CODE,
        categories: [],
        searchPriceItems: true,
      }),
      signal: opts.signal,
    });

    const projects = Array.isArray(list?.projects) ? list.projects : [];
    if (projects.length === 0) warnings.push("project/list returned no projects");

    const live = projects.filter(
      (p) => !p.isPrivate && (LIVE_STATUSES.has(clean(p.status ?? "")) || p.comingSoon === true),
    );

    const out: NormalizedOpportunity[] = [];
    for (const p of live) {
      try {
        const externalId = clean(p.financialId ?? "") || String(p.id);
        const title = clean(p.title ?? "");
        if (!title) {
          warnings.push(`project ${p.id}: missing title, skipped`);
          continue;
        }
        const contact = clean(`${p.contactFirstName ?? ""} ${p.contactLastName ?? ""}`);
        out.push({
          externalId,
          title,
          agency: clean(p.departmentName ?? "") || "City of Phoenix",
          category: clean(p.template?.processAcronym ?? p.template?.title ?? "") || null,
          postedDate: isoOrNull(p.postedAt ?? p.postScheduledAt),
          dueDate: isoOrNull(p.proposalDeadline),
          qAndADeadline: isoOrNull(p.qaDeadline),
          detailUrl: `${PORTAL_BASE}/projects/${p.id}`,
          statusOnSite: p.comingSoon ? "Coming Soon" : clean(p.status ?? "") || null,
          raw: {
            projectId: p.id,
            governmentId: p.government_id,
            type: p.type,
            preProposalDate: p.preProposalDate,
            qaResponseDeadline: p.qaResponseDeadline,
            contactName: contact || null,
            templateTitle: p.template?.title ?? null,
          },
        });
      } catch (e) {
        warnings.push(`row parse failed for project ${p?.id}: ${(e as Error).message}`);
      }
    }

    const limited = opts.limit ? out.slice(0, opts.limit) : out;

    // Best-effort hydration: description, NIGP code, attachments.
    let hydrated = 0;
    for (const o of limited) {
      if (hydrated >= MAX_DETAIL_FETCHES) {
        warnings.push(`detail hydration capped at ${MAX_DETAIL_FETCHES} projects`);
        break;
      }
      if (opts.signal?.aborted) break;
      const projectId = (o.raw as { projectId?: number } | undefined)?.projectId;
      if (!projectId) continue;
      try {
        const d = await fetchJson<PhxDetail>(`${API_BASE}/project/${projectId}`, {
          headers: { Accept: "application/json", Referer: PORTAL_BASE },
          signal: opts.signal,
        });
        o.description = htmlToText(d.summary) ?? htmlToText(d.background);
        const cats = Array.isArray(d.categories) ? d.categories : [];
        const nigp = clean(cats[0]?.code ?? "");
        if (nigp) o.naicsCode = nigp; // NIGP commodity code (portal has no NAICS)
        if (cats.length > 0) {
          o.category = clean(cats.map((c) => clean(c.title ?? "")).filter(Boolean).join("; ")) || o.category;
        }
        const atts = Array.isArray(d.attachments) ? d.attachments : [];
        const attachmentUrls = atts
          .map((a) => ({
            filename: clean(a.filename ?? a.title ?? ""),
            url: clean(a.url ?? ""),
          }))
          .filter((a) => a.filename && a.url);
        if (attachmentUrls.length > 0) o.attachmentUrls = attachmentUrls;
      } catch (e) {
        warnings.push(`detail fetch failed for project ${projectId}: ${(e as Error).message}`);
      }
      hydrated++;
      await sleep(DETAIL_CONCURRENCY_DELAY_MS);
    }

    return {
      opportunities: limited,
      warnings,
      methodUsed: "json_api (api.procurement.opengov.com /project/list + /project/:id)",
    };
  },
};
