"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { OPP_STATUSES, PIPELINE_STAGES, type OppStatus, type PipelineStage, type User } from "@/lib/types";
import { OPP_STATUS_STYLES, PIPELINE_STYLES } from "@/lib/status";
import { setStatusAction, setStageAction, assignAction } from "@/app/actions";

export function StatusControls({
  oppId,
  status,
  stage,
  assignedTo,
  users,
}: {
  oppId: string;
  status: OppStatus;
  stage: PipelineStage;
  assignedTo: string | null;
  users: User[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [field, setField] = useState<string>("");

  const run = (f: string, fn: () => Promise<void>) =>
    start(async () => {
      setField(f);
      await fn();
      router.refresh();
      setField("");
    });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Labeled label="Status" busy={pending && field === "status"}>
        <select
          className="input w-auto text-[0.82rem] py-1.5"
          value={status}
          onChange={(e) => run("status", () => setStatusAction(oppId, e.target.value))}
        >
          {OPP_STATUSES.map((s) => (
            <option key={s} value={s}>{OPP_STATUS_STYLES[s].label}</option>
          ))}
        </select>
      </Labeled>

      <Labeled label="Stage" busy={pending && field === "stage"}>
        <select
          className="input w-auto text-[0.82rem] py-1.5"
          value={stage}
          onChange={(e) => run("stage", () => setStageAction(oppId, e.target.value))}
        >
          {PIPELINE_STAGES.map((s) => (
            <option key={s} value={s}>{PIPELINE_STYLES[s].label}</option>
          ))}
        </select>
      </Labeled>

      <Labeled label="Owner" busy={pending && field === "owner"}>
        <select
          className="input w-auto text-[0.82rem] py-1.5"
          value={assignedTo ?? ""}
          onChange={(e) => run("owner", () => assignAction(oppId, e.target.value || null))}
        >
          <option value="">Unassigned</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>{u.name}</option>
          ))}
        </select>
      </Labeled>
    </div>
  );
}

function Labeled({ label, busy, children }: { label: string; busy: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[0.72rem] text-[var(--color-faint)] uppercase tracking-wide">{label}</span>
      {children}
      {busy && <Loader2 size={13} className="animate-spin text-[var(--color-brand-500)]" />}
    </div>
  );
}
