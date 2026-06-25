"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Sparkles,
  Wand2,
  Save,
  Download,
  Trash2,
  RefreshCw,
  Pencil,
  Eye,
  Send,
  Check,
  Columns2,
  Loader2,
} from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { Badge } from "@/components/ui";
import { RESPONSE_STATUS_STYLES } from "@/lib/status";
import { fmtDateTime, cn } from "@/lib/utils";
import type { ResponseDraft, ResponseRevision, ResponseMode } from "@/lib/types";
import {
  generateDraftAction,
  reviseAction,
  saveResponseAction,
  setResponseStatusAction,
  deleteResponseAction,
} from "@/app/actions";

export type ResponseWithRevisions = ResponseDraft & { revisions: ResponseRevision[] };

const MODE_META: Record<ResponseMode, { label: string; blurb: string; icon: typeof Sparkles }> = {
  STYLE_MATCHED: {
    label: "Style-matched",
    blurb: "Mimics your company's voice using RAG over past winning proposals.",
    icon: Sparkles,
  },
  LLM_ORIGINAL: {
    label: "LLM-original",
    blurb: "The strongest response written from scratch, unconstrained by past style.",
    icon: Wand2,
  },
};

export function ResponseWorkspace({
  opportunityId,
  responses,
}: {
  opportunityId: string;
  responses: ResponseWithRevisions[];
}) {
  const [mode, setMode] = useState<ResponseMode>("STYLE_MATCHED");
  const [compare, setCompare] = useState(false);

  const latest = (m: ResponseMode) => responses.filter((r) => r.mode === m)[0] ?? null;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div className="inline-flex rounded-lg border border-[var(--color-border)] p-0.5 bg-[var(--color-surface-2)]">
          {(Object.keys(MODE_META) as ResponseMode[]).map((m) => {
            const Icon = MODE_META[m].icon;
            return (
              <button
                key={m}
                onClick={() => {
                  setMode(m);
                  setCompare(false);
                }}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-[7px] text-[0.82rem] font-medium transition-colors",
                  !compare && mode === m
                    ? "bg-[var(--color-surface)] text-[var(--color-ink)] shadow-sm"
                    : "text-[var(--color-muted)] hover:text-[var(--color-ink)]",
                )}
              >
                <Icon size={14} /> {MODE_META[m].label}
                {latest(m) && <span className="text-[0.65rem] text-[var(--color-faint)]">v{latest(m)!.version_no}</span>}
              </button>
            );
          })}
        </div>
        <button
          onClick={() => setCompare((v) => !v)}
          className={cn("btn btn-ghost btn-sm", compare && "btn-soft")}
        >
          <Columns2 size={14} /> Compare both
        </button>
      </div>

      {compare ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {(Object.keys(MODE_META) as ResponseMode[]).map((m) => (
            <CompareColumn key={m} mode={m} response={latest(m)} opportunityId={opportunityId} />
          ))}
        </div>
      ) : (
        <ModePanel mode={mode} response={latest(mode)} opportunityId={opportunityId} />
      )}
    </div>
  );
}

function GenerateCTA({ mode, opportunityId }: { mode: ResponseMode; opportunityId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const meta = MODE_META[mode];
  const Icon = meta.icon;
  return (
    <div className="border border-dashed border-[var(--color-border-strong)] rounded-xl p-8 text-center bg-[var(--color-surface-2)]">
      <span className="inline-grid place-items-center w-11 h-11 rounded-xl bg-[var(--color-brand-50)] text-[var(--color-brand-600)] mb-3">
        <Icon size={20} />
      </span>
      <h4 className="text-[0.95rem] font-semibold text-[var(--color-ink)]">{meta.label} draft</h4>
      <p className="text-[0.83rem] text-[var(--color-muted)] mt-1 max-w-md mx-auto">{meta.blurb}</p>
      <button
        className="btn btn-primary mt-4"
        disabled={pending}
        onClick={() =>
          start(async () => {
            await generateDraftAction(opportunityId, mode);
            router.refresh();
          })
        }
      >
        {pending ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
        {pending ? "Generating…" : "Generate draft"}
      </button>
    </div>
  );
}

function ModePanel({
  mode,
  response,
  opportunityId,
}: {
  mode: ResponseMode;
  response: ResponseWithRevisions | null;
  opportunityId: string;
}) {
  if (!response) return <GenerateCTA mode={mode} opportunityId={opportunityId} />;
  return <DraftEditor key={`${response.id}:${response.updated_at}`} response={response} opportunityId={opportunityId} />;
}

function DraftEditor({
  response,
  opportunityId,
}: {
  response: ResponseWithRevisions;
  opportunityId: string;
}) {
  const router = useRouter();
  const [content, setContent] = useState(response.content);
  const [editing, setEditing] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [pending, start] = useTransition();
  const [action, setAction] = useState("");
  const dirty = content !== response.content;
  const st = RESPONSE_STATUS_STYLES[response.status];

  const run = (name: string, fn: () => Promise<void>) =>
    start(async () => {
      setAction(name);
      await fn();
      router.refresh();
      setAction("");
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge label={st.label} bg={st.bg} fg={st.fg} />
        <span className="chip">{response.model_used ?? "—"}</span>
        <span className="text-[0.72rem] text-[var(--color-faint)]">Updated {fmtDateTime(response.updated_at)}</span>
        <div className="flex items-center gap-1.5 ml-auto">
          <button className="btn btn-ghost btn-sm" onClick={() => setEditing((v) => !v)}>
            {editing ? <Eye size={13} /> : <Pencil size={13} />}
            {editing ? "Preview" : "Edit"}
          </button>
          {dirty && (
            <button
              className="btn btn-soft btn-sm"
              disabled={pending}
              onClick={() => run("save", () => saveResponseAction(response.id, opportunityId, content))}
            >
              {action === "save" ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save
            </button>
          )}
          <a className="btn btn-ghost btn-sm" href={`/api/responses/${response.id}/export`}>
            <Download size={13} /> Word
          </a>
          <button
            className="btn btn-ghost btn-sm"
            disabled={pending}
            onClick={() => run("regen", () => generateDraftAction(opportunityId, response.mode))}
          >
            {action === "regen" ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Regenerate
          </button>
        </div>
      </div>

      <div className="card p-0 overflow-hidden">
        {editing ? (
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="w-full min-h-[460px] p-5 font-mono text-[0.8rem] leading-relaxed outline-none resize-y bg-[var(--color-surface)]"
            spellCheck={false}
          />
        ) : (
          <div className="p-6 max-h-[600px] overflow-y-auto">
            <Markdown>{content}</Markdown>
          </div>
        )}
      </div>

      {/* Revision loop */}
      <div className="card p-4">
        <label className="label">Request a change (revision loop)</label>
        <div className="flex gap-2">
          <input
            className="input"
            placeholder='e.g. "Make section 3 more concrete with metrics" or "Add our SOC 2 certification"'
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && instruction.trim()) {
                run("revise", async () => {
                  await reviseAction(response.id, opportunityId, instruction.trim());
                  setInstruction("");
                });
              }
            }}
          />
          <button
            className="btn btn-primary"
            disabled={pending || !instruction.trim()}
            onClick={() =>
              run("revise", async () => {
                await reviseAction(response.id, opportunityId, instruction.trim());
                setInstruction("");
              })
            }
          >
            {action === "revise" ? <Loader2 size={15} className="animate-spin" /> : <Wand2 size={15} />}
            Apply
          </button>
        </div>

        {response.revisions.length > 0 && (
          <div className="mt-3 pt-3 border-t border-[var(--color-border)] space-y-1.5">
            <div className="text-[0.72rem] uppercase tracking-wide text-[var(--color-faint)]">
              Revision history ({response.revisions.length})
            </div>
            {response.revisions.map((r) => (
              <div key={r.id} className="text-[0.8rem] text-[var(--color-ink-2)] flex items-start gap-2">
                <span className="text-[var(--color-faint)] tabular-nums">v{r.revision_no}</span>
                <span className="flex-1">“{r.instruction}”</span>
                <span className="text-[0.7rem] text-[var(--color-faint)] whitespace-nowrap">{fmtDateTime(r.revised_at)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Approval workflow */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[0.78rem] text-[var(--color-muted)]">Move this draft:</span>
        {(["IN_REVIEW", "APPROVED", "SUBMITTED", "REJECTED"] as const).map((s) => (
          <button
            key={s}
            className={cn("btn btn-ghost btn-sm", response.status === s && "btn-soft")}
            disabled={pending || response.status === s}
            onClick={() => run(`status-${s}`, () => setResponseStatusAction(response.id, opportunityId, s))}
          >
            {s === "SUBMITTED" ? <Send size={13} /> : s === "APPROVED" ? <Check size={13} /> : null}
            {RESPONSE_STATUS_STYLES[s].label}
          </button>
        ))}
        <button
          className="btn btn-ghost btn-sm text-[var(--color-rose-700)] ml-auto"
          disabled={pending}
          onClick={() => run("delete", () => deleteResponseAction(response.id, opportunityId))}
        >
          <Trash2 size={13} /> Delete
        </button>
      </div>
    </div>
  );
}

function CompareColumn({
  mode,
  response,
  opportunityId,
}: {
  mode: ResponseMode;
  response: ResponseWithRevisions | null;
  opportunityId: string;
}) {
  const meta = MODE_META[mode];
  return (
    <div className="card p-0 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-[var(--color-border)] flex items-center gap-2">
        <meta.icon size={14} className="text-[var(--color-brand-600)]" />
        <span className="text-[0.82rem] font-semibold">{meta.label}</span>
        {response && <span className="chip ml-auto">{response.model_used}</span>}
      </div>
      {response ? (
        <div className="p-5 max-h-[560px] overflow-y-auto">
          <Markdown>{response.content}</Markdown>
        </div>
      ) : (
        <div className="p-5">
          <GenerateCTA mode={mode} opportunityId={opportunityId} />
        </div>
      )}
    </div>
  );
}
