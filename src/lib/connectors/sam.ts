import { fetchJson } from "./http";
import { trimDescription } from "./parse";
import { DEFAULT_TARGETING_PROFILE } from "@/lib/targeting/defaults";
import type {
  Connector,
  ConnectorResult,
  ConnectorRunOptions,
  NormalizedOpportunity,
} from "@/lib/types";

/**
 * SAM.gov — federal opportunities via the official Get Opportunities public API
 * (query mode: the Targeting Profile's NAICS codes + response-deadline window become
 * the API query, per docs/TARGETING-ENGINE-PLAN.md §7). Requires SAM_GOV_API_KEY
 * (free: sam.gov → account → API keys). Without a key the connector reports a
 * warning and returns no items rather than failing the crawl run.
 */
const API = "https://api.sam.gov/opportunities/v2/search";

interface SamOpp {
  noticeId: string;
  solicitationNumber?: string;
  title: string;
  fullParentPathName?: string;
  postedDate?: string;
  responseDeadLine?: string;
  naicsCode?: string;
  classificationCode?: string;
  type?: string;
  typeOfSetAsideDescription?: string;
  description?: string;
  uiLink?: string;
  resourceLinks?: string[];
}

interface SamResponse {
  totalRecords: number;
  opportunitiesData?: SamOpp[];
}

const mmddyyyy = (d: Date) =>
  `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;

export const samConnector: Connector = {
  key: "sam",
  label: "SAM.gov (Federal)",
  async fetchOpenOpportunities(opts: ConnectorRunOptions = {}): Promise<ConnectorResult> {
    const key = process.env.SAM_GOV_API_KEY;
    if (!key) {
      return {
        opportunities: [],
        warnings: ["SAM_GOV_API_KEY not set — get a free key at sam.gov (Account → API keys) and add it to the environment."],
        methodUsed: "json_api (sam.gov) — inactive, no API key",
      };
    }

    const profile = DEFAULT_TARGETING_PROFILE;
    const minDays = profile.dateBands.minDays;
    // §10: never even fetch items with fewer than minDays to respond.
    const from = new Date();
    const postedFrom = new Date(from.getTime() - 30 * 86_400_000);
    const deadlineFrom = new Date(from.getTime() + minDays * 86_400_000);
    const deadlineTo = new Date(from.getTime() + 365 * 86_400_000);

    const out: NormalizedOpportunity[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();
    const limit = Math.min(opts.limit ?? 200, 1000);

    // One query per target NAICS keeps each response small and stays inside the
    // public-API quota; results are deduped on noticeId.
    for (const naics of profile.naics.codes) {
      if (out.length >= limit) break;
      const params = new URLSearchParams({
        api_key: key,
        postedFrom: mmddyyyy(postedFrom),
        postedTo: mmddyyyy(from),
        rdlfrom: mmddyyyy(deadlineFrom),
        rdlto: mmddyyyy(deadlineTo),
        ncode: naics,
        ptype: "o,p,k", // solicitations, presolicitations, combined synopsis/solicitations
        limit: "100",
        offset: "0",
      });
      try {
        const json = await fetchJson<SamResponse>(`${API}?${params}`, { timeoutMs: 60_000, signal: opts.signal });
        for (const o of json.opportunitiesData ?? []) {
          if (seen.has(o.noticeId) || out.length >= limit) continue;
          seen.add(o.noticeId);
          out.push({
            externalId: o.solicitationNumber || o.noticeId,
            title: o.title,
            agency: o.fullParentPathName?.split(".").slice(0, 2).join(" · ") ?? null,
            category: [o.type, o.typeOfSetAsideDescription].filter(Boolean).join(" · ") || null,
            naicsCode: o.naicsCode ?? naics,
            description: trimDescription(o.description),
            postedDate: o.postedDate ? new Date(o.postedDate).toISOString() : null,
            dueDate: o.responseDeadLine ? new Date(o.responseDeadLine).toISOString() : null,
            detailUrl: o.uiLink ?? `https://sam.gov/opp/${o.noticeId}/view`,
            statusOnSite: "Open",
            attachmentUrls: (o.resourceLinks ?? []).slice(0, 10).map((url, i) => ({
              filename: `attachment-${i + 1}`,
              url,
            })),
          });
        }
      } catch (e) {
        warnings.push(`SAM.gov NAICS ${naics}: ${(e as Error).message}`);
      }
    }

    return {
      opportunities: out,
      warnings,
      methodUsed: `json_api (sam.gov v2, ${profile.naics.codes.length} NAICS queries, due ≥ ${minDays}d)`,
    };
  },
};
