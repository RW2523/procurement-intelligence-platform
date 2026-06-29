"use client";

import { useEffect, useRef, useState } from "react";
import {
  FileText,
  Download,
  ExternalLink,
  RefreshCw,
  Loader2,
  Eye,
  AlertCircle,
  FileSearch,
} from "lucide-react";
import type { Attachment } from "@/lib/types";
import { Card, CardHeader, Badge } from "@/components/ui";

const STATUS_STYLE: Record<string, { label: string; bg: string; fg: string }> = {
  parsed: { label: "Parsed", bg: "var(--color-mint-100)", fg: "var(--color-mint-700)" },
  stored: { label: "Stored", bg: "var(--color-sky-100)", fg: "var(--color-sky-700)" },
  pending: { label: "Not fetched", bg: "#eef0f4", fg: "#5b6170" },
  failed: { label: "Failed", bg: "var(--color-rose-100)", fg: "var(--color-rose-700)" },
  too_large: { label: "Too large", bg: "var(--color-amber-100)", fg: "var(--color-amber-700)" },
};

function fmtSize(n: number | null): string {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function isPreviewable(a: Attachment): boolean {
  if (!a.downloaded_at || a.parse_status === "too_large" || a.parse_status === "failed") return false;
  const ct = a.content_type ?? "";
  const name = a.filename ?? "";
  return ct.includes("pdf") || /\.pdf$/i.test(name) || ct.startsWith("image/") || ct.startsWith("text/");
}

export function DocumentsPanel({
  opportunityId,
  initial,
}: {
  opportunityId: string;
  initial: Attachment[];
}) {
  const [attachments, setAttachments] = useState<Attachment[]>(initial);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<"pdf" | "text">("pdf");
  const [textById, setTextById] = useState<Record<string, string>>({});
  const [loadingText, setLoadingText] = useState(false);
  const ranAuto = useRef(false);

  async function loadText(id: string) {
    if (textById[id] !== undefined) return;
    setLoadingText(true);
    try {
      const res = await fetch(`/api/attachments/${id}/text`);
      const data = await res.json();
      setTextById((m) => ({ ...m, [id]: data.text ?? "" }));
    } finally {
      setLoadingText(false);
    }
  }

  const hasPending = attachments.some((a) => a.source_url && !a.downloaded_at);
  const downloaded = attachments.filter((a) => a.downloaded_at && a.parse_status !== "failed");

  async function fetchDocs() {
    if (loading) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/opportunities/${opportunityId}/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max: 10 }),
      });
      const data = await res.json();
      if (data.attachments) {
        setAttachments(data.attachments as Attachment[]);
        const firstPdf = (data.attachments as Attachment[]).find((a) => isPreviewable(a));
        if (firstPdf && !selected) setSelected(firstPdf.id);
      }
    } finally {
      setLoading(false);
    }
  }

  // First view: auto-download already-discovered documents so they're ready to preview.
  useEffect(() => {
    if (ranAuto.current) return;
    ranAuto.current = true;
    if (hasPending) void fetchDocs();
    else {
      const firstPdf = attachments.find((a) => isPreviewable(a));
      if (firstPdf) setSelected(firstPdf.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedDoc = attachments.find((a) => a.id === selected) ?? null;

  return (
    <Card>
      <CardHeader
        title="Documents"
        subtitle={
          attachments.length
            ? `${attachments.length} file${attachments.length === 1 ? "" : "s"} — downloaded and stored for preview`
            : "Solicitation documents (RFP, specs, Q&A) — download from the portal"
        }
        action={
          <button className="btn btn-ghost btn-sm" onClick={fetchDocs} disabled={loading}>
            {loading ? <Loader2 size={14} className="animate-spin" /> : <FileSearch size={14} />}
            {attachments.length ? "Refresh" : "Find documents"}
          </button>
        }
      />

      {attachments.length === 0 && (
        <div className="px-5 py-8 text-center text-[0.85rem] text-[var(--color-muted)]">
          {loading ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 size={15} className="animate-spin" /> Fetching documents from the portal…
            </span>
          ) : (
            <>No documents captured yet. Click <strong>Find documents</strong> to pull them from the portal.</>
          )}
        </div>
      )}

      {attachments.length > 0 && (
        <div className="divide-y divide-[var(--color-border)]">
          {attachments.map((a) => {
            const st = STATUS_STYLE[a.parse_status] ?? STATUS_STYLE.pending;
            const preview = isPreviewable(a);
            return (
              <div
                key={a.id}
                className={`flex items-center gap-3 px-5 py-2.5 ${selected === a.id ? "bg-[var(--color-brand-50)]" : "hover:bg-[var(--color-surface-2)]"}`}
              >
                <FileText size={15} className="text-[var(--color-faint)] shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-[0.85rem] text-[var(--color-ink-2)] truncate">{a.filename}</div>
                  <div className="text-[0.7rem] text-[var(--color-faint)] flex items-center gap-2">
                    {a.byte_size ? <span>{fmtSize(a.byte_size)}</span> : null}
                    {a.fetch_error && (
                      <span className="inline-flex items-center gap-1 text-[var(--color-rose-700)]">
                        <AlertCircle size={11} /> {a.fetch_error}
                      </span>
                    )}
                  </div>
                </div>
                <Badge label={st.label} bg={st.bg} fg={st.fg} />
                {preview && (
                  <button
                    className="btn btn-soft btn-sm"
                    onClick={() => setSelected(selected === a.id ? null : a.id)}
                  >
                    <Eye size={13} /> {selected === a.id ? "Hide" : "Preview"}
                  </button>
                )}
                {a.downloaded_at && a.parse_status !== "failed" && a.parse_status !== "too_large" && (
                  <a className="btn btn-ghost btn-sm" href={`/api/attachments/${a.id}/file?download=1`}>
                    <Download size={13} />
                  </a>
                )}
                {a.source_url && (
                  <a className="btn btn-ghost btn-sm" href={a.source_url} target="_blank" rel="noreferrer">
                    <ExternalLink size={13} />
                  </a>
                )}
              </div>
            );
          })}
        </div>
      )}

      {selectedDoc && isPreviewable(selectedDoc) && (
        <div className="px-5 pb-5 pt-1">
          <div className="flex items-center justify-between mb-2 gap-3">
            <div className="text-[0.72rem] uppercase tracking-wide text-[var(--color-faint)] truncate">
              Preview · {selectedDoc.filename}
            </div>
            {selectedDoc.parse_status === "parsed" && (
              <div className="flex gap-1 shrink-0">
                <button
                  className={`btn btn-sm ${previewMode === "pdf" ? "btn-soft" : "btn-ghost"}`}
                  onClick={() => setPreviewMode("pdf")}
                >
                  PDF
                </button>
                <button
                  className={`btn btn-sm ${previewMode === "text" ? "btn-soft" : "btn-ghost"}`}
                  onClick={() => {
                    setPreviewMode("text");
                    void loadText(selectedDoc.id);
                  }}
                >
                  Text
                </button>
              </div>
            )}
          </div>
          {(selectedDoc.content_type ?? "").startsWith("image/") ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/attachments/${selectedDoc.id}/file`}
              alt={selectedDoc.filename}
              className="max-w-full rounded-lg border border-[var(--color-border)]"
            />
          ) : previewMode === "text" && selectedDoc.parse_status === "parsed" ? (
            <pre className="max-h-[620px] overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4 text-[0.78rem] leading-relaxed whitespace-pre-wrap text-[var(--color-ink-2)]">
              {textById[selectedDoc.id] === undefined
                ? loadingText
                  ? "Loading extracted text…"
                  : "Click Text to load."
                : textById[selectedDoc.id] || "No text extracted."}
            </pre>
          ) : (
            <iframe
              src={`/api/attachments/${selectedDoc.id}/file`}
              title={selectedDoc.filename}
              className="w-full rounded-lg border border-[var(--color-border)] bg-white"
              style={{ height: 620 }}
            />
          )}
        </div>
      )}

      {downloaded.length > 0 && (
        <div className="px-5 pb-4 text-[0.7rem] text-[var(--color-faint)]">
          {downloaded.length} document{downloaded.length === 1 ? "" : "s"} stored in the database · text extracted for AI drafting.
        </div>
      )}
    </Card>
  );
}
