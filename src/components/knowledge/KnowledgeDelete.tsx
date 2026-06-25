"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2 } from "lucide-react";
import { deleteKnowledgeAction } from "@/app/actions";

export function KnowledgeDelete({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      className="text-[var(--color-faint)] hover:text-[var(--color-rose-700)]"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await deleteKnowledgeAction(id);
          router.refresh();
        })
      }
      aria-label="Delete"
    >
      {pending ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
    </button>
  );
}
