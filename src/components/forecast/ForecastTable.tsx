import Link from "next/link";
import { ExternalLink, Award } from "lucide-react";
import type { ForecastRow } from "@/lib/db/forecast";
import { fmtDate, daysUntil } from "@/lib/utils";

/**
 * Only linkify a genuinely absolute http(s) URL. The sheet's link cells carry
 * trailing spaces (trimmed on import) and, in the Pipeline sheet, occasionally
 * a note instead of a URL — and a relative href under the /procurement basePath
 * would resolve to a 404 inside this app rather than the agency's forecast page.
 */
function httpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function ForecastTable({ rows }: { rows: ForecastRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[0.85rem] border-collapse">
        <thead>
          <tr className="text-left text-[0.7rem] uppercase tracking-wide text-[var(--color-faint)] border-b border-[var(--color-border)]">
            <th className="py-2.5 px-4 font-semibold">Title</th>
            <th className="py-2.5 px-3 font-semibold">Agency</th>
            <th className="py-2.5 px-3 font-semibold">Organization</th>
            <th className="py-2.5 px-3 font-semibold">Set-aside</th>
            <th className="py-2.5 px-3 font-semibold">Est. solicitation</th>
            <th className="py-2.5 px-3 font-semibold">Date found</th>
            <th className="py-2.5 px-3 font-semibold">Link</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const url = httpUrl(r.detail_url);
            const d = daysUntil(r.estimated_solicitation_date);
            // Forecast dates are the agency's own estimate, so "soon" is a wide
            // window: 60 days is roughly when capture work has to start.
            const soon = d !== null && d >= 0 && d <= 60;
            return (
              <tr
                key={r.id}
                className="border-b border-[var(--color-border)] hover:bg-[var(--color-surface-2)] transition-colors align-top"
              >
                <td className="py-3 px-4 max-w-[420px]">
                  <div className="font-medium text-[var(--color-ink)]">{r.title}</div>
                  {r.notes && (
                    <div className="text-[0.72rem] text-[var(--color-faint)] mt-0.5 line-clamp-2">{r.notes}</div>
                  )}
                  {r.promoted_opportunity_id && (
                    <Link
                      href={`/opportunities/${r.promoted_opportunity_id}`}
                      className="text-[0.72rem] text-[var(--color-brand-600)] hover:underline mt-0.5 inline-block"
                    >
                      In the pipeline →
                    </Link>
                  )}
                </td>
                <td className="py-3 px-3 whitespace-nowrap font-medium text-[var(--color-ink-2)]">
                  {r.department ?? "—"}
                </td>
                <td className="py-3 px-3 whitespace-nowrap text-[var(--color-ink-2)]">{r.sub_agency ?? "—"}</td>
                <td className="py-3 px-3 whitespace-nowrap">
                  {r.set_asides?.length ? (
                    <span className="inline-flex items-center gap-0.5 text-[var(--color-mint-700)] font-medium">
                      <Award size={11} /> {r.set_asides.join(" · ")}
                    </span>
                  ) : (
                    <span className="text-[0.72rem] text-[var(--color-faint)]">—</span>
                  )}
                </td>
                <td className="py-3 px-3 whitespace-nowrap">
                  <div className={soon ? "text-[var(--color-amber-700)] font-medium" : "text-[var(--color-ink-2)]"}>
                    {fmtDate(r.estimated_solicitation_date)}
                  </div>
                  {d !== null && (
                    <div className="text-[0.7rem] text-[var(--color-faint)]">
                      {d < 0 ? `${-d} day${d === -1 ? "" : "s"} ago` : `in ${d} day${d === 1 ? "" : "s"}`}
                    </div>
                  )}
                </td>
                <td className="py-3 px-3 whitespace-nowrap text-[var(--color-muted)]">{fmtDate(r.date_found)}</td>
                <td className="py-3 px-3">
                  {url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[var(--color-brand-600)] hover:underline"
                    >
                      <ExternalLink size={13} /> Details
                    </a>
                  ) : (
                    <span className="text-[0.72rem] text-[var(--color-faint)]">{r.detail_url ?? "—"}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
