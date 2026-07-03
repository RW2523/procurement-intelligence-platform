"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { Search } from "lucide-react";
import { OPP_STATUSES } from "@/lib/types";
import { OPP_STATUS_STYLES } from "@/lib/status";

const STATES = ["NC", "TN", "AR", "PA", "MA"];

/**
 * The default view is the targeting engine's actionable shortlist:
 * bucket = Pursue + Capture review, due ≥ 10 calendar days (§10).
 * Everything else is opt-in via the selectors.
 */
export function OpportunityFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [q, setQ] = useState(sp.get("q") ?? "");

  useEffect(() => setQ(sp.get("q") ?? ""), [sp]);

  function update(pairs: Record<string, string>) {
    const params = new URLSearchParams(sp.toString());
    for (const [key, value] of Object.entries(pairs)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    router.push(`${pathname}?${params.toString()}`);
  }

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

      <select className="input w-auto" value={sp.get("state") ?? ""} onChange={(e) => update({ state: e.target.value })}>
        <option value="">All states</option>
        {STATES.map((s) => (
          <option key={s} value={s}>{s}</option>
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
