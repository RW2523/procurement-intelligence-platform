"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { FileUp, Loader2, Save, X } from "lucide-react";
import { PIPELINE_STAGES } from "@/lib/types";
import { PIPELINE_STYLES } from "@/lib/status";
import { DEPARTMENTS } from "@/lib/departments";
import { api } from "@/lib/apiPath";
import {
  ALLOWED_UPLOAD_EXTENSIONS,
  MAX_FILE_BYTES,
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_REQUEST_BYTES,
  checkUploadBatch,
  checkUploadFile,
  mb,
} from "@/lib/documents/limits";

/** Convert a datetime-local / date input value to ISO (UTC) for the API. */
function toISO(value: string): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

/**
 * Contract vehicles seen in Pipeline_2026. These are SUGGESTIONS on a free-text
 * input (a <datalist>), never a closed <select>: the list demonstrably grows —
 * two of the six are portal-specific ("Jaggaer MN", "Jaggaer PA") and a new
 * state portal adds another the day it is onboarded.
 */
const VEHICLES = ["SAM", "NY ED", "GSA MAS", "Open Source", "Jaggaer MN", "Jaggaer PA"];

/** Won/Loss values already in the sheet, including the user's own spellings. */
const OUTCOMES = ["in evalution", "RFI no response", "Lost", "Won", "Awarded to competitor"];

export function UploadBidForm() {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set when the bid saved but one or more documents were refused server-side. */
  const [saved, setSaved] = useState<{ id: string; rejected: string[] } | null>(null);

  /**
   * Attach files, refusing anything the API would refuse anyway.
   *
   * This is a courtesy, NOT the security boundary — /api/bids re-checks every
   * one of these server-side (src/lib/documents/limits.ts is imported by both,
   * so the rules cannot drift). Doing it here means the user hears "that file
   * is 40 MB" instantly instead of after uploading 40 MB over a phone
   * connection to be met with a 413.
   */
  function addFiles(list: FileList | null) {
    if (!list) return;
    // Computed against `files` rather than inside a setFiles updater: the
    // updater can run twice (StrictMode) and must stay free of side effects.
    const next = [...files];
    let rejected: string | null = null;
    for (const f of Array.from(list)) {
      if (next.some((x) => x.name === f.name && x.size === f.size)) continue;
      const bad = checkUploadFile(f) ?? checkUploadBatch([...next, f]);
      if (bad) {
        rejected ??= bad;
        continue;
      }
      next.push(f);
    }
    setFiles(next);
    setError(rejected);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const formEl = e.currentTarget;
    const fd = new FormData(formEl);
    // Normalize the optional exact-datetime pickers to ISO; drop empties so the
    // API falls back to parsing the free-text cell the user actually typed.
    for (const key of ["due_date", "q_and_a_deadline"]) {
      const v = fd.get(key);
      fd.set(key, typeof v === "string" ? toISO(v) : "");
    }
    fd.delete("files");
    // Re-checked here as well as on attach: a file can be swapped on disk
    // between picking it and submitting, and the server check is the real gate.
    const badBatch = checkUploadBatch(files);
    if (badBatch) {
      setError(badBatch);
      setBusy(false);
      return;
    }
    for (const f of files) fd.append("files", f);

    try {
      const res = await fetch(api("/api/bids"), { method: "POST", body: fd });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      // The bid saved, but a document was refused on its CONTENT (an .pdf that
      // isn't a PDF, an HTML error page saved as .docx) — something only the
      // server could tell. Say so and stay put rather than navigating away and
      // leaving the user to notice a missing attachment later, or never.
      const refused: string[] = json.documents?.rejected ?? [];
      if (refused.length) {
        setSaved({ id: json.id, rejected: refused });
        setBusy(false);
        return;
      }
      router.push(`/opportunities/${json.id}`);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card p-6 max-w-3xl space-y-6">
      {/* ── Identification ─────────────────────────────────────────────────── */}
      <Section
        title="The opportunity"
        hint="Mirrors your Pipeline sheet, column for column. Only the title is required."
      >
        <Field className="sm:col-span-2" label="Title *">
          <input
            name="title"
            required
            className="input"
            placeholder="e.g. Information Technology Staff Augmentation Services"
          />
        </Field>

        <Field label="Share / No Share">
          <select name="is_shared" className="input" defaultValue="No">
            <option value="No">No — keep internal</option>
            <option value="Yes">Yes — share with partners</option>
          </select>
        </Field>
        <Field label="Date found" hint="Defaults to today. This is your discovery date, not the crawl date.">
          <input name="date_found" type="date" className="input" />
        </Field>

        {/* The five priority codes are SUGGESTIONS on a free-text input, never a
            closed list: the sheet also carries DOJ, GSA, USDA, HUD, Navy, NSF and
            FEC, and the five departments are a filter + scoring bonus, not a gate.
            Values come from src/lib/departments.ts so this cannot drift from the
            filter dropdown on /opportunities. Left blank, the API derives it. */}
        <Field label="Department" hint="Left blank, we read it from the agency / POC block.">
          <input name="department" list="dept-list" className="input" placeholder="e.g. DOT" />
          <datalist id="dept-list">
            {DEPARTMENTS.map((d) => (
              <option key={d.code} value={d.code}>
                {d.name}
              </option>
            ))}
          </datalist>
        </Field>
        <Field label="Sub-agency / organization" hint='The half after the slash in "DOT/FAA".'>
          <input name="sub_agency" className="input" placeholder="e.g. FAA" />
        </Field>

        <Field label="Issuing agency">
          <input name="agency" className="input" placeholder="e.g. Federal Aviation Administration" />
        </Field>
        <Field label="State" hint="Two-letter code, for hand-entered rows.">
          <input name="state" className="input" placeholder="e.g. NY" maxLength={2} />
        </Field>

        <Field className="sm:col-span-2" label="Agency / POC" hint="Paste the whole contact block — it is kept verbatim.">
          <textarea
            name="poc_raw"
            rows={3}
            className="input resize-y"
            placeholder={"Jordan A. Reyes\n(202) 555-0142\njordan.reyes@dot.gov"}
          />
        </Field>
        <Field label="POC name">
          <input name="poc_name" className="input" placeholder="e.g. Jordan A. Reyes" />
        </Field>
        <Field label="POC email">
          <input name="poc_email" type="email" className="input" placeholder="name@agency.gov" />
        </Field>
        <Field label="POC phone">
          <input name="poc_phone" className="input" placeholder="(202) 555-0142" />
        </Field>

        <Field label="Contract vehicle" hint="Type anything — the list is only a shortcut.">
          <input
            name="contract_vehicle"
            list="vehicle-list"
            className="input"
            placeholder="e.g. GSA MAS"
          />
          <datalist id="vehicle-list">
            {VEHICLES.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </Field>

        <Field className="sm:col-span-2" label="RFx #" hint="Verbatim. The last line becomes the tracking number.">
          <textarea
            name="rfx_number_raw"
            rows={2}
            className="input resize-y"
            placeholder={"Notice ID\n6973GH-26-R-01234   (auto-generated if blank)"}
          />
        </Field>

        <Field className="sm:col-span-2" label="Website / listing">
          <input
            name="detail_url"
            className="input"
            placeholder="https://sam.gov/…  (or a note, e.g. “Email from 3/23 from Anita”)"
          />
        </Field>

        <Field className="sm:col-span-2" label="Description / scope">
          <textarea
            name="description"
            rows={4}
            className="input resize-y"
            placeholder="Paste the summary or scope here — the AI uses it for the bid/no-bid check and for drafting."
          />
        </Field>

        <Field label="NAICS code(s)" hint='Multiple codes are fine: "54151S & 518210C".'>
          <input name="naics_code" className="input" placeholder="e.g. 541511" />
        </Field>
        <Field label="Category / type">
          <input name="category" className="input" placeholder="e.g. RFP · IT services" />
        </Field>

        <Field label="Period of performance">
          <input name="period_of_performance" className="input" placeholder="e.g. 09/25/2026 - 09/24/2031" />
        </Field>
        <Field label="Estimated value" hint='Free text — "1.96B BPA" is kept as written and read as a number where possible.'>
          <input name="estimated_value" className="input" placeholder="e.g. 250,000 or 1.96B BPA" />
        </Field>

        <Field label="Set-aside(s)" hint="Comma-separated.">
          <input name="set_asides" className="input" placeholder="e.g. SB, SBA OWSB" />
        </Field>
        <Field label="Capture stage">
          <select name="pipeline_stage" className="input" defaultValue="IDENTIFIED">
            {PIPELINE_STAGES.map((s) => (
              <option key={s} value={s}>
                {PIPELINE_STYLES[s].label}
              </option>
            ))}
          </select>
        </Field>
      </Section>

      {/* ── Dates ──────────────────────────────────────────────────────────── */}
      <Section
        title="Dates"
        hint="Type the deadline exactly as the portal states it. The picker beside it is optional and only feeds the reminder emails — leave it blank and we read the text."
      >
        <Field label="Questions due">
          <input
            name="q_and_a_deadline_text"
            className="input"
            placeholder="e.g. 4/22/2026 2:00 PM EDT"
          />
        </Field>
        <Field label="Questions due — exact (optional)">
          <input name="q_and_a_deadline" type="datetime-local" className="input" />
        </Field>
        <Field label="Due date">
          <input name="due_date_text" className="input" placeholder="e.g. 1/31/2026 11:59 pm CT" />
        </Field>
        <Field label="Due date — exact (optional)">
          <input name="due_date" type="datetime-local" className="input" />
        </Field>
      </Section>

      {/* ── Tracking ───────────────────────────────────────────────────────── */}
      <Section title="Tracking" hint="Where this pursuit stands, and what it taught us.">
        <Field className="sm:col-span-2" label="Status / follow-ups" hint="Your running log — dated notes are ideal.">
          <textarea
            name="capture_notes"
            rows={3}
            className="input resize-y"
            placeholder={"4/3: Sent Antony the opportunity folder.\n4/9: Proposal submitted via eVA this morning."}
          />
        </Field>
        <Field label="Won / Loss" hint="A separate axis from the capture stage.">
          <input name="outcome" list="outcome-list" className="input" placeholder="e.g. in evalution" />
          <datalist id="outcome-list">
            {OUTCOMES.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        </Field>
        <Field label="Lessons learned">
          <input name="lessons_learned" className="input" placeholder="What would we do differently?" />
        </Field>
      </Section>

      {/* ── Documents ──────────────────────────────────────────────────────── */}
      <div>
        <label className="label">Bid documents (RFP, specs, amendments, Q&amp;A)</label>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className="w-full border-2 border-dashed border-[var(--color-border-strong)] rounded-lg p-6 text-center hover:border-[var(--color-brand-400)] hover:bg-[var(--color-brand-50)] transition-colors"
        >
          <FileUp size={22} className="mx-auto mb-1.5 text-[var(--color-faint)]" />
          <div className="text-[0.85rem] font-medium text-[var(--color-ink-2)]">Click to attach documents</div>
          {/* The numbers come from the same module the API enforces, so this
              can never promise a limit the server does not honour. */}
          <div className="text-[0.75rem] text-[var(--color-faint)] mt-0.5">
            PDF preferred (text is extracted for the AI) · up to {MAX_UPLOAD_FILES} files ·{" "}
            {mb(MAX_FILE_BYTES)} each · {mb(MAX_UPLOAD_REQUEST_BYTES)} total
          </div>
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={ALLOWED_UPLOAD_EXTENSIONS.map((e) => `.${e}`).join(",")}
          className="hidden"
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        {files.length > 0 && (
          <ul className="mt-2 space-y-1">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`} className="chip w-full justify-between">
                <span className="truncate">{f.name}</span>
                <span className="flex items-center gap-2 shrink-0">
                  <span className="text-[var(--color-faint)]">{(f.size / 1024).toFixed(0)} KB</span>
                  <button
                    type="button"
                    aria-label={`Remove ${f.name}`}
                    onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                    className="text-[var(--color-faint)] hover:text-[var(--color-rose-500)]"
                  >
                    <X size={14} />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && (
        <div className="text-[0.83rem] text-[var(--color-rose-700)] bg-[var(--color-rose-100)] rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {/* The bid saved but a document was refused on inspection. Reported here
          instead of navigating away, so a rejected attachment is never silent. */}
      {saved && (
        <div className="text-[0.83rem] text-[var(--color-amber-700)] bg-[var(--color-amber-100)] rounded-lg px-3 py-2 space-y-1">
          <div className="font-medium">The bid was saved, but some documents were not attached:</div>
          <ul className="list-disc pl-4">
            {saved.rejected.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <button
            type="button"
            className="underline font-medium"
            onClick={() => {
              router.push(`/opportunities/${saved.id}`);
              router.refresh();
            }}
          >
            Open the bid workspace anyway
          </button>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy || !!saved} className="btn btn-primary">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
          {busy ? "Saving bid…" : "Save bid & open workspace"}
        </button>
        <span className="text-[0.75rem] text-[var(--color-faint)]">
          Saves into the pipeline · documents parsed for the AI · lands on the full bid workspace
        </span>
      </div>
    </form>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset>
      <legend className="text-[0.8rem] font-semibold uppercase tracking-wide text-[var(--color-faint)]">
        {title}
      </legend>
      {hint && <p className="text-[0.78rem] text-[var(--color-muted)] mt-1 mb-3">{hint}</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">{children}</div>
    </fieldset>
  );
}

function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <label className="label">{label}</label>
      {children}
      {hint && <p className="text-[0.72rem] text-[var(--color-faint)] mt-1">{hint}</p>}
    </div>
  );
}
