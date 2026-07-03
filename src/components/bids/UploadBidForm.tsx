"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { FileUp, Loader2, Save, X } from "lucide-react";
import { PIPELINE_STAGES } from "@/lib/types";
import { PIPELINE_STYLES } from "@/lib/status";

/** Convert a datetime-local / date input value to ISO (UTC) for the API. */
function toISO(value: string): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

export function UploadBidForm() {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addFiles(list: FileList | null) {
    if (!list) return;
    setFiles((prev) => {
      const next = [...prev];
      for (const f of Array.from(list)) {
        if (!next.some((x) => x.name === f.name && x.size === f.size)) next.push(f);
      }
      return next.slice(0, 12);
    });
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const formEl = e.currentTarget;
    const fd = new FormData(formEl);
    // Normalize date inputs to ISO; drop empties so the API sees clean fields.
    for (const key of ["due_date", "q_and_a_deadline"]) {
      const v = fd.get(key);
      fd.set(key, typeof v === "string" ? toISO(v) : "");
    }
    fd.delete("files");
    for (const f of files) fd.append("files", f);

    try {
      const res = await fetch("/api/bids", { method: "POST", body: fd });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      router.push(`/opportunities/${json.id}`);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card p-6 max-w-3xl space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2">
          <label className="label">Bid title *</label>
          <input name="title" required className="input" placeholder="e.g. Web Development & Support Services for MassArt.edu" />
        </div>
        <div>
          <label className="label">Bid / solicitation #</label>
          <input name="external_id" className="input" placeholder="e.g. RFP 26-11 (auto-generated if blank)" />
        </div>
        <div>
          <label className="label">Issuing agency</label>
          <input name="agency" className="input" placeholder="e.g. Massachusetts College of Art and Design" />
        </div>
        <div>
          <label className="label">Category / type</label>
          <input name="category" className="input" placeholder="e.g. RFP · IT services" />
        </div>
        <div>
          <label className="label">NAICS code</label>
          <input name="naics_code" className="input" placeholder="e.g. 541511" />
        </div>
        <div>
          <label className="label">Response due</label>
          <input name="due_date" type="datetime-local" className="input" />
        </div>
        <div>
          <label className="label">Q&amp;A deadline</label>
          <input name="q_and_a_deadline" type="datetime-local" className="input" />
        </div>
        <div>
          <label className="label">Estimated value (USD)</label>
          <input name="estimated_value" className="input" placeholder="e.g. 250000" inputMode="numeric" />
        </div>
        <div>
          <label className="label">Current stage</label>
          <select name="pipeline_stage" className="input" defaultValue="REVIEWING">
            {PIPELINE_STAGES.map((s) => (
              <option key={s} value={s}>
                {PIPELINE_STYLES[s].label}
              </option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className="label">Portal / listing URL</label>
          <input name="detail_url" type="url" className="input" placeholder="https://…" />
        </div>
        <div className="sm:col-span-2">
          <label className="label">Scope / description</label>
          <textarea
            name="description"
            rows={4}
            className="input resize-y"
            placeholder="What is this bid about? Paste the summary or scope here — the AI uses it for the bid/no-bid check and drafting."
          />
        </div>
      </div>

      {/* Documents */}
      <div>
        <label className="label">Bid documents (RFP, specs, amendments, Q&amp;A)</label>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className="w-full border-2 border-dashed border-[var(--color-border-strong)] rounded-lg p-6 text-center hover:border-[var(--color-brand-400)] hover:bg-[var(--color-brand-50)] transition-colors"
        >
          <FileUp size={22} className="mx-auto mb-1.5 text-[var(--color-faint)]" />
          <div className="text-[0.85rem] font-medium text-[var(--color-ink-2)]">Click to attach documents</div>
          <div className="text-[0.75rem] text-[var(--color-faint)] mt-0.5">
            PDF preferred (text is extracted for the AI) · up to 12 files · 9 MB each
          </div>
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".pdf,.doc,.docx,.xls,.xlsx,.txt,.rtf,.zip"
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

      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy} className="btn btn-primary">
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
