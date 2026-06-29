"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { Search } from "lucide-react";
import { OPP_STATUSES } from "@/lib/types";
import { OPP_STATUS_STYLES } from "@/lib/status";

const STATES = ["NC", "TN", "AR", "PA", "MA"];

export function OpportunityFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [q, setQ] = useState(sp.get("q") ?? "");

  useEffect(() => setQ(sp.get("q") ?? ""), [sp]);

  function update(key: string, value: string) {
    const params = new URLSearchParams(sp.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      <form
        className="relative flex-1 min-w-[220px] max-w-sm"
        onSubmit={(e) => {
          e.preventDefault();
          update("q", q);
        }}
      >
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-faint)]" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, agency, #…" className="input pl-9" />
      </form>

      <select className="input w-auto" value={sp.get("state") ?? ""} onChange={(e) => update("state", e.target.value)}>
        <option value="">All states</option>
        {STATES.map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>

      <select className="input w-auto" value={sp.get("status") ?? ""} onChange={(e) => update("status", e.target.value)}>
        <option value="">All statuses</option>
        {OPP_STATUSES.map((s) => (
          <option key={s} value={s}>{OPP_STATUS_STYLES[s].label}</option>
        ))}
      </select>

      <select className="input w-auto" value={sp.get("sort") ?? "newest"} onChange={(e) => update("sort", e.target.value)}>
        <option value="newest">Newest first</option>
        <option value="due_date">Due date</option>
        <option value="relevance">Relevance</option>
      </select>

      <label className="chip cursor-pointer select-none">
        <input
          type="checkbox"
          className="accent-[var(--color-brand-600)]"
          checked={sp.get("relevant") !== "0"}
          onChange={(e) => update("relevant", e.target.checked ? "" : "0")}
        />
        Strong fit only
      </label>
    </div>
  );
}
