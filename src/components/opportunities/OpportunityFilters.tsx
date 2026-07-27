"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useState } from "react";
import { Search } from "lucide-react";
import { OPP_STATUSES, PIPELINE_STAGES } from "@/lib/types";
import { OPP_STATUS_STYLES, PIPELINE_STYLES } from "@/lib/status";
import { DEPARTMENTS } from "@/lib/departments";

/**
 * Display names for the state codes stored on a row — in `sources.state` for
 * crawled rows, in `opportunities.state` for hand-entered ones. Presentation
 * only: the <option> VALUE is always the raw stored string, never a label and
 * never a re-cased copy of it. 'US' is SAM.gov's federal-wide marker.
 */
const STATE_NAMES: Record<string, string> = {
  US: "Federal (SAM.gov)",
  AK: "Alaska", AL: "Alabama", AR: "Arkansas", AZ: "Arizona", CA: "California",
  CO: "Colorado", CT: "Connecticut", DC: "District of Columbia", DE: "Delaware",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", IA: "Iowa", ID: "Idaho",
  IL: "Illinois", IN: "Indiana", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  MA: "Massachusetts", MD: "Maryland", ME: "Maine", MI: "Michigan",
  MN: "Minnesota", MO: "Missouri", MS: "Mississippi", MT: "Montana",
  NC: "North Carolina", ND: "North Dakota", NE: "Nebraska", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NV: "Nevada", NY: "New York", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", PR: "Puerto Rico",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
  TX: "Texas", UT: "Utah", VA: "Virginia", VT: "Vermont", WA: "Washington",
  WI: "Wisconsin", WV: "West Virginia", WY: "Wyoming",
};

function stateLabel(raw: string): string {
  const key = raw.trim().toUpperCase();
  const name = STATE_NAMES[key];
  return name ? `${key} — ${name}` : key;
}

/**
 * The default view is the targeting engine's actionable shortlist:
 * bucket = Pursue + Capture review, due ≥ 10 calendar days (§10).
 * Everything else is opt-in via the selectors.
 *
 * `states` comes from the server component and must be the UNION of the states
 * on `sources` and the states on `opportunities`, as actually stored — see
 * listFilterStates() in src/lib/db/states.ts, which is the query that produces
 * it. Two earlier versions of this list were wrong in the same way: first a
 * hardcoded five-code array, then `sources.state` alone. Both offered fewer
 * codes than the rows really carry, and a state that no crawl source covers —
 * every state the operator hand-typed — simply had no option to pick.
 */
export function OpportunityFilters({ states = [] }: { states?: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  // Keep the search box in sync with "?q=" (back button, cleared filters)
  // by adjusting state during render rather than in an effect — the effect
  // version trips react-hooks/set-state-in-effect and costs a cascading render.
  const urlQ = sp.get("q") ?? "";
  const [q, setQ] = useState(urlQ);
  const [syncedQ, setSyncedQ] = useState(urlQ);
  if (urlQ !== syncedQ) {
    setSyncedQ(urlQ);
    setQ(urlQ);
  }

  function update(pairs: Record<string, string>) {
    const params = new URLSearchParams(sp.toString());
    for (const [key, value] of Object.entries(pairs)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    router.push(`${pathname}?${params.toString()}`);
  }

  // The URL may carry a differently-cased state (a bookmark, a hand-typed link).
  // The page canonicalises it before querying, so match the same way here or the
  // <select> would fall back to "All states" while the list is in fact filtered.
  const stateParam = (sp.get("state") ?? "").trim();
  const knownState = states.find((s) => s.trim().toUpperCase() === stateParam.toUpperCase());
  // A "?state=" the option list does not know is still APPLIED by the page — it
  // is passed through to the query unchanged. Showing "All states" in that case
  // would be a lie about a filtered list, so the unknown code gets an option of
  // its own and stays selectable/clearable.
  const selectedState = knownState ?? stateParam;
  const stateOptions = knownState || !stateParam ? states : [...states, stateParam];

  return (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      <form
        className="relative flex-1 min-w-[200px] max-w-sm"
        onSubmit={(e) => {
          e.preventDefault();
          update({ q });
        }}
      >
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-faint)]" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, agency, #…" className="input pl-9" />
      </form>

      {/* Targeting bucket — the primary lens */}
      <select className="input w-auto" value={sp.get("view") ?? "ACTIONABLE"} onChange={(e) => update({ view: e.target.value })}>
        <option value="ACTIONABLE">🎯 Pursue + Capture review</option>
        <option value="PURSUE">Pursue immediately (80+)</option>
        <option value="CAPTURE_REVIEW">Capture review (60–79)</option>
        <option value="MANUAL_REVIEW">Manual review (40–59)</option>
        <option value="IGNORE">Ignored (&lt;40 / excluded)</option>
        <option value="INSUFFICIENT_TIME">Insufficient time (&lt;10 days)</option>
        <option value="ALL">Everything</option>
      </select>

      {/* Priority departments (DOT, DOI, DOE, VA, HHS) — a lens on what was
          crawled, not a restriction on what gets crawled. */}
      <select className="input w-auto" value={sp.get("department") ?? ""} onChange={(e) => update({ department: e.target.value })}>
        <option value="">All departments</option>
        {DEPARTMENTS.map((d) => (
          <option key={d.code} value={d.code}>{d.code} — {d.name}</option>
        ))}
      </select>

      {/* Capture stage — the team's own axis, distinct from solicitation status */}
      <select className="input w-auto" value={sp.get("stage") ?? ""} onChange={(e) => update({ stage: e.target.value })}>
        <option value="">Any capture stage</option>
        {PIPELINE_STAGES.map((s) => (
          <option key={s} value={s}>{PIPELINE_STYLES[s].label}</option>
        ))}
      </select>

      <select className="input w-auto" value={sp.get("urgency") ?? ""} onChange={(e) => update({ urgency: e.target.value })}>
        <option value="">Any urgency</option>
        <option value="URGENT">Urgent (10–20 days)</option>
        <option value="STANDARD">Standard (21–45 days)</option>
        <option value="EARLY_CAPTURE">Early capture (46+ days)</option>
      </select>

      <select className="input w-auto" value={sp.get("setAside") ?? ""} onChange={(e) => update({ setAside: e.target.value })}>
        <option value="">Any set-aside status</option>
        <option value="ANY">Has a set-aside</option>
        <option value="8(a)">8(a)</option>
        <option value="WOSB">WOSB / EDWOSB</option>
        <option value="Sole Source">Sole Source / Direct Award</option>
        <option value="Small Business">Small Business</option>
        <option value="HUBZone">HUBZone</option>
        <option value="SDVOSB">SDVOSB</option>
        <option value="MBE">MBE</option>
      </select>

      <select className="input w-auto" value={sp.get("vehicle") ?? ""} onChange={(e) => update({ vehicle: e.target.value })}>
        <option value="">Any vehicle</option>
        <option value="ANY">Has a vehicle</option>
        <option value="GSA MAS">GSA MAS</option>
        <option value="BPA">BPA</option>
        <option value="Blanket Purchase Agreement">Blanket Purchase Agreement</option>
        <option value="Task Order">Task Order</option>
      </select>

      <select className="input w-auto" value={selectedState} onChange={(e) => update({ state: e.target.value })}>
        <option value="">All states</option>
        {stateOptions.map((s) => (
          <option key={s} value={s}>{stateLabel(s)}</option>
        ))}
      </select>

      <select className="input w-auto" value={sp.get("status") ?? ""} onChange={(e) => update({ status: e.target.value })}>
        <option value="">All statuses</option>
        {OPP_STATUSES.map((s) => (
          <option key={s} value={s}>{OPP_STATUS_STYLES[s].label}</option>
        ))}
      </select>

      <select className="input w-auto" value={sp.get("sort") ?? "score"} onChange={(e) => update({ sort: e.target.value })}>
        <option value="score">Highest score</option>
        <option value="newest">Newest first</option>
        <option value="due_date">Due date</option>
        <option value="relevance">AI relevance</option>
      </select>
    </div>
  );
}
