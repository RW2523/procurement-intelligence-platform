"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search, Bell, Check } from "lucide-react";
import { Avatar } from "@/components/ui";
import { NOTIF_STYLES } from "@/lib/status";
import { markAllReadAction } from "@/app/actions";
import { fmtDateTime, titleCase } from "@/lib/utils";
import type { Notification, User } from "@/lib/types";

export function Topbar({
  user,
  unread,
  notifications,
}: {
  user: User | null;
  unread: number;
  notifications: Notification[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  return (
    <header className="h-16 shrink-0 bg-[var(--color-surface)] border-b border-[var(--color-border)] flex items-center gap-3 px-6">
      <form
        className="relative flex-1 max-w-md"
        onSubmit={(e) => {
          e.preventDefault();
          router.push(`/opportunities${q ? `?q=${encodeURIComponent(q)}` : ""}`);
        }}
      >
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-faint)]" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search opportunities, agencies, solicitation #…"
          className="input pl-9"
        />
      </form>

      <div className="flex items-center gap-1.5 ml-auto">
        <div className="relative">
          <button
            onClick={() => setOpen((v) => !v)}
            className="relative grid place-items-center w-9 h-9 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-ink-2)]"
            aria-label="Notifications"
          >
            <Bell size={18} />
            {unread > 0 && (
              <span className="absolute top-1 right-1 min-w-4 h-4 px-1 grid place-items-center text-[0.6rem] font-bold text-white rounded-full bg-[var(--color-rose-500)]">
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </button>
          {open && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
              <div className="absolute right-0 mt-2 w-[360px] z-20 card shadow-[var(--shadow-pop)] overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
                  <span className="text-[0.85rem] font-semibold">Notifications</span>
                  <button
                    className="text-[0.75rem] text-[var(--color-brand-600)] flex items-center gap-1 hover:underline"
                    onClick={async () => {
                      await markAllReadAction();
                      setOpen(false);
                    }}
                  >
                    <Check size={13} /> Mark all read
                  </button>
                </div>
                <div className="max-h-[380px] overflow-y-auto">
                  {notifications.length === 0 && (
                    <div className="px-4 py-8 text-center text-[0.82rem] text-[var(--color-muted)]">
                      No notifications yet.
                    </div>
                  )}
                  {notifications.map((n) => {
                    const meta = NOTIF_STYLES[n.type];
                    return (
                      <Link
                        key={n.id}
                        href={n.opportunity_id ? `/opportunities/${n.opportunity_id}` : "/notifications"}
                        onClick={() => setOpen(false)}
                        className="flex gap-3 px-4 py-3 border-b border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"
                        style={{ background: n.is_read ? undefined : "var(--color-brand-50)" }}
                      >
                        <span className="text-base leading-none mt-0.5">{meta?.emoji ?? "🔔"}</span>
                        <div className="min-w-0">
                          <div className="text-[0.82rem] font-medium text-[var(--color-ink)] truncate">{n.title}</div>
                          {n.body && <div className="text-[0.76rem] text-[var(--color-muted)] line-clamp-2">{n.body}</div>}
                          <div className="text-[0.68rem] text-[var(--color-faint)] mt-0.5">{fmtDateTime(n.created_at)}</div>
                        </div>
                      </Link>
                    );
                  })}
                </div>
                <Link
                  href="/notifications"
                  onClick={() => setOpen(false)}
                  className="block text-center py-2.5 text-[0.8rem] font-medium text-[var(--color-brand-600)] hover:bg-[var(--color-surface-2)]"
                >
                  View all
                </Link>
              </div>
            </>
          )}
        </div>

        {user && (
          <div className="flex items-center gap-2.5 pl-2">
            <Avatar name={user.name} size={32} />
            <div className="leading-tight hidden sm:block">
              <div className="text-[0.82rem] font-medium text-[var(--color-ink)]">{user.name}</div>
              <div className="text-[0.68rem] text-[var(--color-faint)]">{titleCase(user.role)}</div>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
