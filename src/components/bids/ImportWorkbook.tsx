"use client";

import { useState, useRef } from "react";
import { Upload, FileSpreadsheet, AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { api } from "@/lib/apiPath";
import { PIPELINE_STYLES } from "@/lib/status";

/**
 * Upload a Pipeline workbook, look at what it would do, then commit.
 *
 * The preview step is deliberately not skippable. The workbook is filled in by
 * hand, so the mapper has to interpret cells like "1.96B BPA", a Due Date with
 * two dates in it, or an RFx # of "RFI??". Those interpretations are shown as
 * "what we had to work out" BEFORE anything is written, because the person who
 * typed the cell is the only one who can tell whether the guess is right.
 */

interface RowPreview {
  sheetRow: number;
  externalId: string;
  title: string | null;
  agency: string | null;
  stage: string;
  department: string | null;
  state: string | null;
  dueDate: string | null;
  bucket: string | null;
  score: number | null;
}
interface Issue { row: number; level: "SKIP" | "WARN"; field: string; detail: string }
interface Report {
  committed: boolean;
  fileName: string;
  pipeline: { sheet: string; headerRow: number; matched: number; total: number; missing: string[] } | null;
  forecast: { sheet: string; matched: number; total: number } | null;
  rowsRead: number;
  blankRows: number;
  forecastRowsRead: number;
  mapped: number;
  counts: { inserted: number; updated: number; unchanged: number;
            fInserted: number; fUpdated: number; fUnchanged: number };
  failures: { row: number; error: string }[];
  stages: Record<string, number>;
  departments: Record<string, number>;
  rows: RowPreview[];
  issues: Issue[];
}

export function ImportWorkbook() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<"" | "preview" | "commit">("");
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function send(commit: boolean) {
    if (!file) return;
    setBusy(commit ? "commit" : "preview");
    setError(null);
    try {
      const body = new FormData();
      body.set("file", file);
      if (commit) body.set("commit", "true");
      const res = await fetch(api("/api/import/pipeline"), { method: "POST", body });
      const json = await res.json();
      if (!res.ok) { setError(json.error ?? `Import failed (${res.status}).`); setReport(null); return; }
      setReport(json as Report);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The upload did not complete.");
    } finally {
      setBusy("");
    }
  }

  function pick(f: File | null) {
    setFile(f);
    setReport(null);
    setError(null);
  }

  const skips = report?.issues.filter((i) => i.level === "SKIP") ?? [];
  const warns = report?.issues.filter((i) => i.level === "WARN") ?? [];

  return (
    <div className="flex flex-col gap-5">
      {/* ── choose a file ───────────────────────────────────────────────── */}
      <div className="card p-5">
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx"
            className="hidden"
            onChange={(e) => pick(e.target.files?.[0] ?? null)}
          />
          <button type="button" className="btn btn-soft" onClick={() => inputRef.current?.click()}>
            <FileSpreadsheet size={15} /> Choose a workbook
          </button>
          <span className="text-[0.86rem] text-[var(--color-muted)]">
            {file ? `${file.name} · ${(file.size / 1024).toFixed(0)} KB` : "No file chosen — .xlsx only"}
          </span>
          <div className="flex-1" />
          <button
            type="button"
            className="btn btn-primary"
            disabled={!file || busy !== ""}
            onClick={() => send(false)}
          >
            <Upload size={15} /> {busy === "preview" ? "Reading…" : "Check the file"}
          </button>
        </div>
        <p className="mt-3 text-[0.82rem] text-[var(--color-muted)]">
          Nothing is saved until you confirm. Re-uploading a corrected copy of the same
          workbook is safe — rows already imported are matched on their RFx&nbsp;# and left
          alone unless something actually changed.
        </p>
      </div>

      {error && (
        <div className="card p-4 flex gap-3 items-start border-[var(--color-rose-300,#f5b5b0)]">
          <AlertTriangle size={17} className="text-[var(--color-rose-600,#b02a21)] mt-0.5 shrink-0" />
          <div>
            <div className="font-semibold text-[0.9rem]">That file could not be imported</div>
            <div className="text-[0.86rem] text-[var(--color-muted)] mt-1">{error}</div>
          </div>
        </div>
      )}

      {report && (
        <>
          {/* ── what happened / would happen ─────────────────────────────── */}
          <div className="card p-5">
            <div className="flex items-center gap-2 mb-3">
              {report.committed
                ? <CheckCircle2 size={17} className="text-[var(--color-mint-600,#2f6b4f)]" />
                : <Info size={17} className="text-[var(--color-sky-600,#0e7c86)]" />}
              <span className="font-semibold">
                {report.committed ? "Imported" : "Ready to import"} — {report.fileName}
              </span>
            </div>

            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))" }}>
              <Stat label={report.committed ? "New bids added" : "Will be added"} value={report.counts.inserted} />
              <Stat label={report.committed ? "Updated" : "Will be updated"} value={report.counts.updated} />
              <Stat label="Already up to date" value={report.counts.unchanged} />
              <Stat label="Forecast rows" value={report.counts.fInserted + report.counts.fUpdated} />
              {report.failures.length > 0 && <Stat label="Failed" value={report.failures.length} bad />}
            </div>

            <p className="mt-4 text-[0.84rem] text-[var(--color-muted)]">
              Read <strong>{report.rowsRead}</strong> rows from “{report.pipeline?.sheet}”
              {report.blankRows > 0 && <> (plus {report.blankRows} blank {report.blankRows === 1 ? "row" : "rows"} ignored)</>},
              matching {report.pipeline?.matched}/{report.pipeline?.total} expected columns.
              {report.forecast && <> Forecast sheet “{report.forecast.sheet}”: {report.forecastRowsRead} rows.</>}
            </p>

            <div className="mt-4 flex flex-wrap gap-1.5">
              {Object.entries(report.stages).sort((a, b) => b[1] - a[1]).map(([s, n]) => (
                <span key={s} className="chip" title={`${n} bid${n === 1 ? "" : "s"} at this capture stage`}>
                  {PIPELINE_STYLES[s as keyof typeof PIPELINE_STYLES]?.label ?? s} · {n}
                </span>
              ))}
            </div>

            {!report.committed && (
              <div className="mt-5 pt-4 border-t border-[var(--color-border)] flex items-center gap-3 flex-wrap">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy !== ""}
                  onClick={() => send(true)}
                >
                  {busy === "commit"
                    ? "Importing…"
                    : `Import ${report.counts.inserted + report.counts.updated} bid${
                        report.counts.inserted + report.counts.updated === 1 ? "" : "s"}`}
                </button>
                <span className="text-[0.82rem] text-[var(--color-muted)]">
                  They appear in My&nbsp;Bids and on the pipeline board straight away.
                </span>
              </div>
            )}
          </div>

          {/* ── rows the mapper could not place ──────────────────────────── */}
          {skips.length > 0 && (
            <IssueList
              tone="bad"
              title={`${skips.length} row${skips.length === 1 ? "" : "s"} could not be imported`}
              blurb="These are listed so nothing disappears silently. Fix the cell in Excel and upload again."
              issues={skips}
            />
          )}

          {/* ── judgement calls ──────────────────────────────────────────── */}
          {warns.length > 0 && (
            <IssueList
              tone="warn"
              title={`${warns.length} thing${warns.length === 1 ? "" : "s"} had to be worked out`}
              blurb="Every one of these rows IS imported. This is what the cell did not say outright — check anything that looks wrong before you confirm."
              issues={warns}
            />
          )}

          {/* ── the rows themselves ──────────────────────────────────────── */}
          <div className="card overflow-hidden">
            <div className="px-5 py-3 border-b border-[var(--color-border)] text-[0.82rem] text-[var(--color-muted)]">
              <span className="font-semibold text-[var(--color-ink)]">{report.rows.length}</span> rows,
              in spreadsheet order
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="w-full text-[0.84rem]">
                <thead>
                  <tr className="text-left text-[var(--color-muted)]">
                    <Th>Row</Th><Th>RFx #</Th><Th>Title</Th><Th>Agency</Th>
                    <Th>Stage</Th><Th>Dept</Th><Th>State</Th><Th>Due</Th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((r) => (
                    <tr key={`${r.sheetRow}-${r.externalId}`} className="border-t border-[var(--color-border)]">
                      <Td mono>{r.sheetRow}</Td>
                      <Td mono>{r.externalId}</Td>
                      <Td>
                        <span style={{ display: "block", maxWidth: "34ch", overflow: "hidden",
                                       textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {r.title ?? "—"}
                        </span>
                      </Td>
                      <Td>
                        <span style={{ display: "block", maxWidth: "22ch", overflow: "hidden",
                                       textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {r.agency ?? "—"}
                        </span>
                      </Td>
                      <Td>{PIPELINE_STYLES[r.stage as keyof typeof PIPELINE_STYLES]?.label ?? r.stage}</Td>
                      <Td>{r.department ?? "—"}</Td>
                      <Td>{r.state ?? "—"}</Td>
                      <Td mono>{r.dueDate ? r.dueDate.slice(0, 10) : "—"}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, bad }: { label: string; value: number; bad?: boolean }) {
  return (
    <div>
      <div className="text-[1.35rem] font-semibold leading-tight"
           style={bad ? { color: "var(--color-rose-600,#b02a21)" } : undefined}>
        {value}
      </div>
      <div className="text-[0.76rem] text-[var(--color-muted)] mt-0.5">{label}</div>
    </div>
  );
}

function IssueList(
  { tone, title, blurb, issues }:
  { tone: "bad" | "warn"; title: string; blurb: string; issues: Issue[] },
) {
  return (
    <div className="card p-5">
      <div className="flex items-center gap-2">
        <AlertTriangle
          size={16}
          style={{ color: tone === "bad" ? "var(--color-rose-600,#b02a21)" : "var(--color-amber-600,#a16207)" }}
        />
        <span className="font-semibold text-[0.92rem]">{title}</span>
      </div>
      <p className="text-[0.83rem] text-[var(--color-muted)] mt-1.5 mb-3">{blurb}</p>
      <ul className="flex flex-col gap-1.5">
        {issues.map((i, n) => (
          <li key={n} className="text-[0.83rem] flex gap-2">
            <span className="text-[var(--color-muted)] shrink-0" style={{ fontVariantNumeric: "tabular-nums" }}>
              row {i.row}
            </span>
            <span className="chip shrink-0">{i.field}</span>
            <span>{i.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const Th = ({ children }: { children: React.ReactNode }) => (
  <th className="px-4 py-2 font-semibold whitespace-nowrap">{children}</th>
);
const Td = ({ children, mono }: { children: React.ReactNode; mono?: boolean }) => (
  <td className="px-4 py-2 align-top whitespace-nowrap"
      style={mono ? { fontVariantNumeric: "tabular-nums" } : undefined}>
    {children}
  </td>
);
