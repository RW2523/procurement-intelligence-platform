"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Inbox,
  Briefcase,
  KanbanSquare,
  Radar,
  BookOpen,
  BarChart3,
  Bell,
  Settings,
  Sparkles,
} from "lucide-react";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { href: "/opportunities", label: "Opportunities", icon: Inbox },
  { href: "/my-bids", label: "My Bids", icon: Briefcase },
  { href: "/board", label: "Pipeline Board", icon: KanbanSquare },
  { href: "/sources", label: "Sources", icon: Radar },
  { href: "/knowledge", label: "Knowledge Library", icon: BookOpen },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/notifications", label: "Notifications", icon: Bell },
  { href: "/admin", label: "Admin", icon: Settings },
];

export function Sidebar({ company }: { company: string }) {
  const pathname = usePathname();
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
        {NAV.map((item) => {
          const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
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
