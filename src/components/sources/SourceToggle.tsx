"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pause, Play, Loader2 } from "lucide-react";
import { updateSourceAction } from "@/app/actions";

export function SourceToggle({ id, isActive }: { id: string; isActive: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      className="btn btn-ghost btn-sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await updateSourceAction(id, { is_active: !isActive, status: isActive ? "paused" : "active" });
          router.refresh();
        })
      }
    >
      {pending ? <Loader2 size={13} className="animate-spin" /> : isActive ? <Pause size={13} /> : <Play size={13} />}
      {isActive ? "Pause" : "Activate"}
    </button>
  );
}
