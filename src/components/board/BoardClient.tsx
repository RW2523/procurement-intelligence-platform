"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, GripVertical } from "lucide-react";
import { PIPELINE_STAGES, type OpportunityView, type PipelineStage } from "@/lib/types";
import { PIPELINE_STYLES, OPP_STATUS_STYLES, BUCKET_STYLES, URGENCY_STYLES } from "@/lib/status";
import { setStageAction } from "@/app/actions";
import { fmtDate, deadlineLabel, daysUntil, cn } from "@/lib/utils";

export function BoardClient({ board }: { board: Record<PipelineStage, OpportunityView[]> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<PipelineStage | null>(null);

  function move(oppId: string, stage: PipelineStage) {
    start(async () => {
      await setStageAction(oppId, stage);
      router.refresh();
    });
  }

  return (
    <div className="flex gap-3 overflow-x-auto pb-4 -mx-6 px-6">
      {PIPELINE_STAGES.map((stage) => {
        const items = board[stage] ?? [];
        const style = PIPELINE_STYLES[stage];
        return (
          <div
            key={stage}
            onDragOver={(e) => {
              e.preventDefault();
              setOverStage(stage);
            }}
            onDrop={() => {
              if (dragId) move(dragId, stage);
              setDragId(null);
              setOverStage(null);
            }}
            className={cn(
              "w-[280px] shrink-0 rounded-xl bg-[var(--color-surface-2)] border transition-colors",
              overStage === stage ? "border-[var(--color-brand-400)]" : "border-[var(--color-border)]",
            )}
          >
            <div className="flex items-center justify-between px-3 py-2.5 sticky top-0">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full" style={{ background: style.dot }} />
                <span className="text-[0.82rem] font-semibold text-[var(--color-ink)]">{style.label}</span>
              </div>
              <span className="text-[0.72rem] text-[var(--color-faint)] tabular-nums">{items.length}</span>
            </div>
            <div className="px-2 pb-2 space-y-2 min-h-[120px]">
              {items.map((o) => {
                const st = OPP_STATUS_STYLES[o.status];
                const d = daysUntil(o.due_date);
                const closing = d !== null && d >= 0 && d <= 7;
                return (
                  <div
                    key={o.id}
                    draggable
                    onDragStart={() => setDragId(o.id)}
                    onDragEnd={() => setDragId(null)}
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
                        <option key={s} value={s}>Move to: {PIPELINE_STYLES[s].label}</option>
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
  );
}
