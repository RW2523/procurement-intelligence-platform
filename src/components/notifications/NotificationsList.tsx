"use client";

import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCheck, Circle } from "lucide-react";
import { NOTIF_STYLES } from "@/lib/status";
import { fmtDateTime } from "@/lib/utils";
import { markReadAction, markAllReadAction } from "@/app/actions";
import type { Notification } from "@/lib/types";

const SEV: Record<string, string> = {
  info: "var(--color-sky-500)",
  warning: "var(--color-amber-500)",
  critical: "var(--color-rose-500)",
};

export function NotificationsList({ notifications }: { notifications: Notification[] }) {
  const router = useRouter();
  const [, start] = useTransition();
  const unread = notifications.filter((n) => !n.is_read).length;

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--color-border)]">
        <span className="text-[0.85rem] text-[var(--color-muted)]">
          <span className="font-semibold text-[var(--color-ink)]">{unread}</span> unread · {notifications.length} total
        </span>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => start(async () => { await markAllReadAction(); router.refresh(); })}
        >
          <CheckCheck size={14} /> Mark all read
        </button>
      </div>
      <div className="divide-y divide-[var(--color-border)]">
        {notifications.length === 0 && (
          <div className="py-12 text-center text-[0.85rem] text-[var(--color-muted)]">No notifications yet.</div>
        )}
        {notifications.map((n) => {
          const meta = NOTIF_STYLES[n.type];
          const Inner = (
            <div className="flex gap-3 px-5 py-3.5" style={{ background: n.is_read ? undefined : "var(--color-brand-50)" }}>
              <span className="text-lg leading-none mt-0.5">{meta?.emoji ?? "🔔"}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: SEV[n.severity] }} />
                  <span className="text-[0.88rem] font-medium text-[var(--color-ink)]">{n.title}</span>
                </div>
                {n.body && <div className="text-[0.8rem] text-[var(--color-muted)] mt-0.5">{n.body}</div>}
                <div className="text-[0.7rem] text-[var(--color-faint)] mt-1">{meta?.label} · {fmtDateTime(n.created_at)}</div>
              </div>
              {!n.is_read && (
                <button
                  className="text-[var(--color-faint)] hover:text-[var(--color-brand-600)] self-start"
                  onClick={(e) => {
                    e.preventDefault();
                    start(async () => { await markReadAction(n.id); router.refresh(); });
                  }}
                  aria-label="Mark read"
                >
                  <Circle size={12} fill="currentColor" />
                </button>
              )}
            </div>
          );
          return n.opportunity_id ? (
            <Link key={n.id} href={`/opportunities/${n.opportunity_id}`} className="block hover:bg-[var(--color-surface-2)]">{Inner}</Link>
          ) : (
            <div key={n.id} className="hover:bg-[var(--color-surface-2)]">{Inner}</div>
          );
        })}
      </div>
    </div>
  );
}
