"use client";

import { useState, useTransition } from "react";
import { AlertCircle, Check, Pencil, X } from "lucide-react";
import { updateBidDetailsAction } from "@/app/actions";
import { BID_FIELDS, missingFields, type BidField, type BidLike } from "@/lib/bids/completeness";
import { DEPARTMENTS } from "@/lib/departments";

/**
 * "These details are missing — add them here."
 *
 * Shown on a bid whose spreadsheet row did not carry everything. The gaps are
 * listed first, with the reason each one matters, because a blank field on its
 * own does not tell you whether it is worth chasing. Every other editable field
 * is behind "Edit all details", so the common case (fill in the two things that
 * are missing) is not buried in a form of twenty inputs.
 */

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA",
  "ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR",
  "PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","PR","GU","VI",
];

function initialValue(bid: BidLike, f: BidField): string {
  const raw = bid[f.key];
  if (raw === null || raw === undefined) return "";
  if (Array.isArray(raw)) return raw.join(", ");
  if (f.input === "datetime" || f.input === "date") {
    // <input type="datetime-local"> wants YYYY-MM-DDTHH:mm with no zone.
    const s = String(raw);
    return f.input === "date" ? s.slice(0, 10) : s.slice(0, 16);
  }
  return String(raw);
}

export function MissingDetails({ bid, canEdit }: { bid: BidLike; canEdit: boolean }) {
  const missing = missingFields(bid);
  const needed = missing.filter((f) => f.weight === "blocking");
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const id = String(bid.id ?? "");
  const fields = showAll ? BID_FIELDS : missing;

  function begin(all: boolean) {
    const src = all ? BID_FIELDS : missing;
    const d: Record<string, string> = {};
    for (const f of src) d[f.key] = initialValue(bid, f);
    setDraft(d);
    setShowAll(all);
    setOpen(true);
    setSaved(false);
    setError(null);
  }

  function save() {
    setError(null);
    start(async () => {
      try {
        // Only send what the operator actually changed, so a field left alone is
        // never rewritten (and never clobbers a value set elsewhere).
        const patch: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(draft)) {
          const before = initialValue(bid, BID_FIELDS.find((f) => f.key === k)!);
          if (v !== before) patch[k] = v;
        }
        if (!Object.keys(patch).length) { setOpen(false); return; }
        await updateBidDetailsAction(id, patch);
        setSaved(true);
        setOpen(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not save those details.");
      }
    });
  }

  if (!missing.length && !open) {
    return canEdit ? (
      <div className="flex items-center gap-2 text-[0.82rem] text-[var(--color-muted)]">
        <Check size={14} /> All tracked details are filled in.
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => begin(true)}>
          <Pencil size={13} /> Edit details
        </button>
      </div>
    ) : null;
  }

  return (
    <div className="card p-5">
      {!open && (
        <>
          <div className="flex items-center gap-2 mb-1">
            <AlertCircle size={16} className="text-[var(--color-amber-600,#a16207)]" />
            <span className="font-semibold text-[0.92rem]">
              {needed.length
                ? `${needed.length} detail${needed.length === 1 ? "" : "s"} needed`
                : `${missing.length} optional detail${missing.length === 1 ? "" : "s"} not filled in`}
            </span>
            {saved && (
              <span className="chip" style={{ color: "var(--color-mint-700,#245c43)" }}>
                <Check size={12} /> saved
              </span>
            )}
          </div>
          <p className="text-[0.83rem] text-[var(--color-muted)] mb-3">
            The spreadsheet row did not carry these. Nothing is wrong with the import —
            the information simply was not in the file.
            {!needed.length && " None of these block working the bid; fill them in when you have them."}
          </p>

          <ul className="flex flex-col gap-2 mb-4">
            {missing.map((f) => (
              <li key={f.key} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[0.85rem]">
                <span className="font-medium">{f.label}</span>
                {f.weight === "blocking" && (
                  <span className="chip" style={{ color: "var(--color-amber-700,#8a5a08)" }}>needed</span>
                )}
                <span className="text-[var(--color-muted)] text-[0.8rem]">{f.why}</span>
              </li>
            ))}
          </ul>

          {canEdit && (
            <div className="flex gap-2 flex-wrap">
              <button type="button" className="btn btn-primary btn-sm" onClick={() => begin(false)}>
                <Pencil size={13} /> Add the missing details
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => begin(true)}>
                Edit all details
              </button>
            </div>
          )}
        </>
      )}

      {open && (
        <>
          <div className="flex items-center justify-between mb-3">
            <span className="font-semibold text-[0.92rem]">
              {showAll ? "Edit details" : "Add the missing details"}
            </span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
              <X size={14} /> Cancel
            </button>
          </div>

          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))" }}>
            {fields.map((f) => (
              <label key={f.key} className="flex flex-col gap-1">
                <span className="text-[0.78rem] font-medium">
                  {f.label}
                  {f.weight === "blocking" && (
                    <span className="text-[var(--color-amber-700,#8a5a08)]"> · needed</span>
                  )}
                </span>
                {f.input === "department" ? (
                  <select
                    className="input"
                    value={draft[f.key] ?? ""}
                    onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                  >
                    <option value="">— none —</option>
                    {DEPARTMENTS.map((d) => (
                      <option key={d.code} value={d.code}>{d.code} — {d.name}</option>
                    ))}
                  </select>
                ) : f.input === "state" ? (
                  <select
                    className="input"
                    value={draft[f.key] ?? ""}
                    onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                  >
                    <option value="">— none —</option>
                    {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                ) : (
                  <input
                    className="input"
                    type={f.input === "datetime" ? "datetime-local" : f.input === "date" ? "date" : "text"}
                    inputMode={f.input === "money" ? "decimal" : undefined}
                    placeholder={f.input === "money" ? "e.g. 250000" : undefined}
                    value={draft[f.key] ?? ""}
                    onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                  />
                )}
                <span className="text-[0.74rem] text-[var(--color-muted)]">{f.why}</span>
              </label>
            ))}
          </div>

          {error && (
            <p className="mt-3 text-[0.83rem]" style={{ color: "var(--color-rose-600,#b02a21)" }}>{error}</p>
          )}

          <div className="mt-4 flex gap-2">
            <button type="button" className="btn btn-primary btn-sm" disabled={pending} onClick={save}>
              {pending ? "Saving…" : "Save details"}
            </button>
            {!showAll && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => begin(true)}>
                Show every field
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
