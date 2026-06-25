import Link from "next/link";
import type { ReactNode } from "react";
import { cn, initials } from "@/lib/utils";

// ── Card ────────────────────────────────────────────────────────────────────
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("card", className)}>{children}</div>;
}
export function CardHeader({
  title,
  subtitle,
  action,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-3 px-5 py-4 border-b border-[var(--color-border)]", className)}>
      <div>
        <h3 className="text-[0.95rem] font-semibold text-[var(--color-ink)]">{title}</h3>
        {subtitle && <p className="text-[0.8rem] text-[var(--color-muted)] mt-0.5">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

// ── Badge ─────────────────────────────────────────────────────────────────--
export function Badge({
  label,
  bg,
  fg,
  dot,
  className,
}: {
  label: ReactNode;
  bg?: string;
  fg?: string;
  dot?: string;
  className?: string;
}) {
  return (
    <span className={cn("badge", className)} style={{ background: bg, color: fg }}>
      {dot && <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: dot }} />}
      {label}
    </span>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────--
export function Stat({
  label,
  value,
  hint,
  icon,
  accent,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  accent?: string;
}) {
  return (
    <div className="stat-card">
      <div className="flex items-center justify-between">
        <span className="text-[0.78rem] font-medium text-[var(--color-muted)]">{label}</span>
        {icon && (
          <span
            className="grid place-items-center w-7 h-7 rounded-lg"
            style={{ background: accent ?? "var(--color-brand-50)", color: "var(--color-brand-600)" }}
          >
            {icon}
          </span>
        )}
      </div>
      <div className="mt-2 text-[1.7rem] font-semibold leading-none tracking-tight text-[var(--color-ink)]">
        {value}
      </div>
      {hint && <div className="mt-1.5 text-[0.78rem] text-[var(--color-muted)]">{hint}</div>}
    </div>
  );
}

// ── Page header ───────────────────────────────────────────────────────────--
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
      <div>
        <h1 className="text-[1.5rem] font-semibold tracking-tight text-[var(--color-ink)]">{title}</h1>
        {subtitle && <p className="text-[0.9rem] text-[var(--color-muted)] mt-1">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────--
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-14 px-6">
      {icon && <div className="text-[var(--color-faint)] mb-3">{icon}</div>}
      <h3 className="text-[0.95rem] font-semibold text-[var(--color-ink-2)]">{title}</h3>
      {description && <p className="text-[0.85rem] text-[var(--color-muted)] mt-1 max-w-md">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// ── Avatar ────────────────────────────────────────────────────────────────--
export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  return (
    <span
      className="inline-grid place-items-center rounded-full font-semibold text-white shrink-0"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.38,
        background: "linear-gradient(135deg, var(--color-brand-500), var(--color-violet-500))",
      }}
    >
      {initials(name)}
    </span>
  );
}

// ── Relevance bar ─────────────────────────────────────────────────────────--
export function RelevanceBar({ score }: { score: number | null | undefined }) {
  const s = score ?? 0;
  const color = s >= 70 ? "var(--color-mint-500)" : s >= 40 ? "var(--color-amber-500)" : "var(--color-faint)";
  return (
    <div className="flex items-center gap-2 min-w-[90px]">
      <div className="flex-1 h-1.5 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${s}%`, background: color }} />
      </div>
      <span className="text-[0.72rem] tabular-nums text-[var(--color-muted)] w-6 text-right">
        {score == null ? "—" : Math.round(s)}
      </span>
    </div>
  );
}

// ── Button-as-link helper ─────────────────────────────────────────────────--
export function LinkButton({
  href,
  children,
  variant = "ghost",
  className,
}: {
  href: string;
  children: ReactNode;
  variant?: "primary" | "ghost" | "soft";
  className?: string;
}) {
  return (
    <Link href={href} className={cn("btn", `btn-${variant}`, className)}>
      {children}
    </Link>
  );
}
