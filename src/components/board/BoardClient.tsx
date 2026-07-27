"use client";

import { useState, useTransition, type DragEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, GripVertical, ChevronLeft, ChevronRight } from "lucide-react";
import { PIPELINE_STAGES, type OpportunityView, type PipelineStage } from "@/lib/types";
import { PIPELINE_STYLES, OPP_STATUS_STYLES, BUCKET_STYLES, URGENCY_STYLES } from "@/lib/status";
import { setStageAction } from "@/app/actions";
import { fmtDate, deadlineLabel, daysUntil, cn } from "@/lib/utils";

/**
 * Stages that end a pursuit. Eleven 280px columns is ~3,100px of board — more
 * than twice a laptop viewport — so these three start COLLAPSED to a 44px rail.
 * Collapsing (rather than dropping them) keeps every stage on screen, keeps the
 * counts visible, and keeps each rail a live drop target: dragging a card onto a
 * collapsed rail still calls setStageAction, so nothing is unreachable.
 */
const DEFAULT_COLLAPSED: PipelineStage[] = ["NO_BID", "WON", "LOST"];

export function BoardClient({ board }: { board: Record<PipelineStage, OpportunityView[]> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<PipelineStage | null>(null);
  const [collapsed, setCollapsed] = useState<Set<PipelineStage>>(() => new Set(DEFAULT_COLLAPSED));

  function move(oppId: string, stage: PipelineStage) {
    start(async () => {
      await setStageAction(oppId, stage);
      router.refresh();
    });
  }

  function toggle(stage: PipelineStage) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(stage)) next.delete(stage);
      else next.add(stage);
      return next;
    });
  }

  const hidden = collapsed.size;

  return (
    <>
      <div className="flex items-center justify-between gap-3 mb-2">
        <p className="text-[0.76rem] text-[var(--color-faint)]">
          {hidden > 0
            ? `${PIPELINE_STAGES.length - hidden} of ${PIPELINE_STAGES.length} stages expanded — collapsed stages stay droppable.`
            : `All ${PIPELINE_STAGES.length} stages expanded — scroll sideways.`}
        </p>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="chip cursor-pointer disabled:opacity-40 disabled:cursor-default"
            onClick={() => setCollapsed(new Set())}
            disabled={hidden === 0}
          >
            Expand all
          </button>
          <button
            type="button"
            className="chip cursor-pointer"
            onClick={() => setCollapsed(new Set(DEFAULT_COLLAPSED))}
          >
            Collapse closed stages
          </button>
        </div>
      </div>

      <div className="flex gap-3 overflow-x-auto pb-4 -mx-6 px-6 items-start">
        {PIPELINE_STAGES.map((stage) => {
          const items = board[stage] ?? [];
          const style = PIPELINE_STYLES[stage];
          const isCollapsed = collapsed.has(stage);
          const dropProps = {
            onDragOver: (e: DragEvent) => {
              e.preventDefault();
              setOverStage(stage);
            },
            onDrop: () => {
              if (dragId) move(dragId, stage);
              setDragId(null);
              setOverStage(null);
            },
          };

          if (isCollapsed) {
            return (
              <button
                key={stage}
                type="button"
                {...dropProps}
                onClick={() => toggle(stage)}
                title={`${style.label} — ${items.length} · click to expand`}
                aria-label={`Expand ${style.label} (${items.length})`}
                className={cn(
                  "w-11 shrink-0 self-stretch min-h-[220px] rounded-xl bg-[var(--color-surface-2)] border",
                  "flex flex-col items-center gap-2 py-3 cursor-pointer transition-colors",
                  overStage === stage ? "border-[var(--color-brand-400)]" : "border-[var(--color-border)]",
                )}
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: style.dot }} />
                <span className="text-[0.72rem] text-[var(--color-faint)] tabular-nums">{items.length}</span>
                <span
                  className="text-[0.78rem] font-semibold text-[var(--color-ink)] whitespace-nowrap"
                  style={{ writingMode: "vertical-rl" }}
                >
                  {style.label}
                </span>
                <ChevronRight size={13} className="text-[var(--color-faint)] mt-auto shrink-0" />
              </button>
            );
          }

          return (
            <div
              key={stage}
              {...dropProps}
              className={cn(
                "w-[280px] shrink-0 rounded-xl bg-[var(--color-surface-2)] border transition-colors flex flex-col",
                overStage === stage ? "border-[var(--color-brand-400)]" : "border-[var(--color-border)]",
              )}
            >
              {/* sticky within this column's own scroll area, so the stage name
                  stays visible while a long column is scrolled */}
              <div className="flex items-center justify-between px-3 py-2.5 sticky top-0 z-10 rounded-t-xl bg-[var(--color-surface-2)] border-b border-[var(--color-border)]">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: style.dot }} />
                  <span className="text-[0.82rem] font-semibold text-[var(--color-ink)] truncate">{style.label}</span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="text-[0.72rem] text-[var(--color-faint)] tabular-nums">{items.length}</span>
                  <button
                    type="button"
                    onClick={() => toggle(stage)}
                    title={`Collapse ${style.label}`}
                    aria-label={`Collapse ${style.label}`}
                    className="text-[var(--color-faint)] hover:text-[var(--color-ink)] cursor-pointer"
                  >
                    <ChevronLeft size={14} />
                  </button>
                </div>
              </div>
              <div className="px-2 pb-2 pt-2 space-y-2 min-h-[120px] max-h-[70vh] overflow-y-auto">
                {items.map((o) => {
                  const st = OPP_STATUS_STYLES[o.status];
                  const d = daysUntil(o.due_date);
                  const closing = d !== null && d >= 0 && d <= 7;
                  return (
                    <div
                      key={o.id}
                      draggable
                      onDragStart={() => setDragId(o.id)}
                      onDragEnd={() => {
                        setDragId(null);
                        setOverStage(null);
                      }}
                      className="card p-3 cursor-grab active:cursor-grabbing group"
                    >
                      <div className="flex items-start gap-1.5">
                        <GripVertical size={14} className="text-[var(--color-faint)] mt-0.5 opacity-0 group-hover:opacity-100 shrink-0" />
                        <Link href={`/opportunities/${o.id}`} className="text-[0.83rem] font-medium text-[var(--color-ink)] hover:text-[var(--color-brand-600)] line-clamp-2 leading-snug">
                          {o.title}
                        </Link>
                      </div>
                      <div className="text-[0.7rem] text-[var(--color-faint)] mt-1 font-mono">{o.external_id}</div>
                      <div className="flex items-center flex-wrap gap-1 mt-2">
                        <span className="badge" style={{ background: st.bg, color: st.fg }}>{st.label}</span>
                        {o.pursuit_bucket && (
                          <span
                            className="badge"
                            style={{ background: BUCKET_STYLES[o.pursuit_bucket].bg, color: BUCKET_STYLES[o.pursuit_bucket].fg }}
                            title={`Targeting score ${o.pursuit_score}`}
                          >
                            {o.pursuit_score} · {BUCKET_STYLES[o.pursuit_bucket].label}
                          </span>
                        )}
                        {o.urgency && o.urgency !== "NO_DATE" && (
                          <span
                            className="badge"
                            style={{ background: URGENCY_STYLES[o.urgency].bg, color: URGENCY_STYLES[o.urgency].fg }}
                          >
                            {URGENCY_STYLES[o.urgency].label}
                          </span>
                        )}
                        <span className="chip ml-auto">{o.source?.state ?? "—"}</span>
                      </div>
                      {o.due_date && (
                        <div className={`text-[0.7rem] mt-1.5 ${closing ? "text-[var(--color-rose-700)] font-medium" : "text-[var(--color-faint)]"}`}>
                          {fmtDate(o.due_date)} · {deadlineLabel(o.due_date)}
                        </div>
                      )}
                      <select
                        className="input mt-2 text-[0.72rem] py-1 cursor-pointer"
                        value={stage}
                        onChange={(e) => move(o.id, e.target.value as PipelineStage)}
                      >
                        {PIPELINE_STAGES.map((s) => (
                          <option key={s} value={s}>
                            {s === stage ? PIPELINE_STYLES[s].label : `Move to: ${PIPELINE_STYLES[s].label}`}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        {pending && (
          <div className="fixed bottom-5 right-5 card px-3 py-2 flex items-center gap-2 text-[0.8rem] shadow-[var(--shadow-pop)]">
            <Loader2 size={14} className="animate-spin text-[var(--color-brand-500)]" /> Updating…
          </div>
        )}
      </div>
    </>
  );
}
