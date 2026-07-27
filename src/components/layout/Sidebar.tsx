"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Inbox,
  Briefcase,
  KanbanSquare,
  Telescope,
  Radar,
  BookOpen,
  BarChart3,
  Bell,
  Settings,
  KeyRound,
  Sparkles,
} from "lucide-react";
import type { UserRole } from "@/lib/types";

// Mirrors RANK in lib/auth/guard.ts, which cannot be imported here: guard.ts is
// `server-only`, and pulling it into a client component breaks the build. This
// copy decides only what is DRAWN.
const RANK: Record<UserRole, number> = { viewer: 1, writer: 2, approver: 3, admin: 4 };

// `min` marks an entry as privileged. It only hides the link — the pages and
// their actions do their own checking (lib/auth/guard.ts), because a nav array
// in a client bundle is a suggestion, not a permission.
const NAV: { href: string; label: string; icon: typeof LayoutDashboard; exact?: boolean; min?: UserRole }[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { href: "/forecast", label: "Forecast", icon: Telescope },
  { href: "/opportunities", label: "Opportunities", icon: Inbox },
  { href: "/my-bids", label: "My Bids", icon: Briefcase },
  { href: "/board", label: "Pipeline Board", icon: KanbanSquare },
  { href: "/sources", label: "Sources", icon: Radar },
  { href: "/knowledge", label: "Knowledge Library", icon: BookOpen },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/notifications", label: "Notifications", icon: Bell },
  { href: "/admin", label: "Admin", icon: Settings, min: "admin" },
  { href: "/admin/access", label: "Access & Roles", icon: KeyRound, min: "admin" },
];

export function Sidebar({ company, role }: { company: string; role?: UserRole | null }) {
  const pathname = usePathname();
  const items = NAV.filter((i) => !i.min || (role ? RANK[role] >= RANK[i.min] : false));
  // Longest matching href wins, so /admin/access highlights itself rather than
  // lighting up "Admin" as well.
  const activeHref = items
    .filter((i) => (i.exact ? pathname === i.href : pathname.startsWith(i.href)))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return (
    <aside className="w-[244px] shrink-0 h-full bg-[var(--color-surface)] border-r border-[var(--color-border)] flex flex-col">
      <div className="px-5 h-16 flex items-center gap-2.5 border-b border-[var(--color-border)]">
        <span
          className="grid place-items-center w-8 h-8 rounded-lg text-white"
          style={{ background: "linear-gradient(135deg, var(--color-brand-500), var(--color-violet-500))" }}
        >
          <Sparkles size={17} />
        </span>
        <div className="leading-tight">
          <div className="text-[0.92rem] font-semibold text-[var(--color-ink)]">{company}</div>
          <div className="text-[0.68rem] text-[var(--color-faint)]">Procurement Intel</div>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-0.5">
        {items.map((item) => {
          const active = item.href === activeHref;
          const Icon = item.icon;
          return (
            <Link key={item.href} href={item.href} data-active={active} className="nav-link">
              <Icon size={17} strokeWidth={2} />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="px-4 py-3 border-t border-[var(--color-border)] text-[0.7rem] text-[var(--color-faint)]">
        Daily crawl · 6:00 AM ET
      </div>
    </aside>
  );
}
