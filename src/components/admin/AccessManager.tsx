"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Check, AlertTriangle, UserPlus, ShieldCheck, ShieldOff, Trash2 } from "lucide-react";
import { grantAccessAction, revokeAccessAction, setAccessActiveAction, type AccessResult } from "@/app/actions";
import { Avatar, Badge, Card, CardHeader } from "@/components/ui";
import { USER_ROLES, type UserRole } from "@/lib/types";
import type { AccessRow, AccessLogRow } from "@/lib/db/access";

/**
 * Grant / change / revoke procurement access.
 *
 * Every button here calls a Server Action, which Next 16 invokes over POST and
 * ONLY over POST — so none of this is reachable by following a link, and a
 * crawler or a prefetch can never change somebody's role. The confirmations and
 * the disabled states below are courtesy, not security: the same three actions
 * re-check requireRole("admin"), self-demotion and the last-admin rule on the
 * server, because a direct POST skips this component entirely.
 */

const ROLE_STYLE: Record<string, { bg: string; fg: string }> = {
  admin: { bg: "var(--color-brand-50)", fg: "var(--color-brand-700)" },
  writer: { bg: "var(--color-violet-100)", fg: "#6d28d9" },
  approver: { bg: "var(--color-mint-100)", fg: "var(--color-mint-700)" },
  viewer: { bg: "#eef0f4", fg: "#5b6170" },
};

function Notice({ result }: { result: AccessResult | null }) {
  if (!result) return null;
  const good = result.ok;
  return (
    <div
      className="flex items-start gap-2 rounded-lg px-3 py-2 text-[0.82rem]"
      style={{
        background: good ? "var(--color-mint-100)" : "var(--color-amber-100)",
        color: good ? "var(--color-mint-700)" : "var(--color-amber-700)",
      }}
    >
      {good ? <Check size={15} className="mt-px shrink-0" /> : <AlertTriangle size={15} className="mt-px shrink-0" />}
      <span>{result.message}</span>
    </div>
  );
}

export function AccessManager({
  rows,
  log,
  currentEmail,
}: {
  rows: AccessRow[];
  log: AccessLogRow[];
  /** The signed-in admin, so the UI can grey out the self-lockout controls the server also refuses. */
  currentEmail: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<AccessResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState<UserRole>("viewer");

  const withAccess = useMemo(() => rows.filter((r) => r.user_id), [rows]);
  const loginOnly = useMemo(() => rows.filter((r) => !r.user_id && r.has_login), [rows]);
  const activeAdmins = useMemo(
    () => withAccess.filter((r) => r.role === "admin" && r.is_active).length,
    [withAccess],
  );

  const run = (key: string, fn: () => Promise<AccessResult>) =>
    start(async () => {
      setBusy(key);
      try {
        setResult(await fn());
        router.refresh();
      } catch (e) {
        // requireRole() throwing means the session lost admin between page load
        // and click — report it rather than leaving a spinner.
        setResult({ ok: false, message: e instanceof Error ? e.message : "That change was refused." });
      } finally {
        setBusy(null);
      }
    });

  const isSelf = (email: string) => email.toLowerCase() === currentEmail.toLowerCase();
  const lastAdmin = (r: AccessRow) => r.role === "admin" && !!r.is_active && activeAdmins <= 1;

  return (
    <div className="space-y-5">
      <Notice result={result} />

      <Card>
        <CardHeader
          title={<span className="flex items-center gap-2"><ShieldCheck size={16} /> Has procurement access</span>}
          subtitle={`${withAccess.length} account(s). Everyone here can open this app; the role decides what they may do.`}
        />
        <div className="divide-y divide-[var(--color-border)]">
          {withAccess.length === 0 && (
            <div className="px-5 py-6 text-[0.85rem] text-[var(--color-muted)]">
              Nobody has access yet. Grant it below, or run{" "}
              <code className="font-mono text-[0.78rem]">npm run access -- bootstrap --yes</code> on the server.
            </div>
          )}
          {withAccess.map((r) => {
            const rs = ROLE_STYLE[r.role ?? "viewer"];
            const self = isSelf(r.email);
            return (
              <div key={r.email} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <Avatar name={r.name || r.email} size={34} />
                <div className="flex-1 min-w-[180px]">
                  <div className="text-[0.88rem] font-medium text-[var(--color-ink)]">
                    {r.name || r.email}
                    {self && <span className="ml-2 text-[0.7rem] text-[var(--color-faint)]">(you)</span>}
                  </div>
                  <div className="text-[0.76rem] text-[var(--color-faint)]">
                    {r.email}
                    {!r.has_login && <span className="ml-2 text-[var(--color-amber-700)]">no AJACE login — can&apos;t sign in</span>}
                    {!r.is_active && <span className="ml-2 text-[var(--color-amber-700)]">deactivated</span>}
                  </div>
                </div>

                <Badge label={r.role ?? "—"} bg={rs?.bg} fg={rs?.fg} />

                <select
                  className="input !w-auto !py-1 text-[0.8rem]"
                  value={r.role ?? "viewer"}
                  disabled={pending || self}
                  title={self ? "You can't change your own role" : "Change role"}
                  onChange={(e) =>
                    run(`role:${r.email}`, () =>
                      grantAccessAction({ email: r.email, role: e.target.value as UserRole }),
                    )
                  }
                >
                  {USER_ROLES.map((role) => (
                    <option key={role} value={role}>{role}</option>
                  ))}
                </select>

                <button
                  className="btn btn-sm"
                  disabled={pending || self || (r.is_active === true && lastAdmin(r))}
                  title={
                    self ? "You can't deactivate your own account"
                      : lastAdmin(r) ? "That's the last active admin"
                      : r.is_active ? "Suspend without deleting" : "Restore access"
                  }
                  onClick={() =>
                    run(`active:${r.email}`, () =>
                      setAccessActiveAction({ email: r.email, active: !r.is_active }),
                    )
                  }
                >
                  {busy === `active:${r.email}` ? <Loader2 size={13} className="animate-spin" /> : <ShieldOff size={13} />}
                  {r.is_active ? "Deactivate" : "Reactivate"}
                </button>

                <button
                  className="btn btn-sm"
                  disabled={pending || self || lastAdmin(r)}
                  title={self ? "You can't revoke your own access" : lastAdmin(r) ? "That's the last active admin" : "Remove procurement access"}
                  onClick={() => {
                    if (!confirm(`Remove procurement access for ${r.email}? Their AJACE login and timesheet are unaffected.`)) return;
                    run(`revoke:${r.email}`, () => revokeAccessAction({ email: r.email }));
                  }}
                >
                  {busy === `revoke:${r.email}` ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                  Revoke
                </button>
              </div>
            );
          })}
        </div>
      </Card>

      <Card>
        <CardHeader
          title={<span className="flex items-center gap-2"><UserPlus size={16} /> AJACE logins without access</span>}
          subtitle="People who can sign in to the timesheet but have no procurement account yet."
        />
        <div className="divide-y divide-[var(--color-border)]">
          {loginOnly.length === 0 && (
            <div className="px-5 py-5 text-[0.85rem] text-[var(--color-muted)]">
              Everyone with an AJACE login already has a procurement account.
            </div>
          )}
          {loginOnly.map((r) => (
            <div key={r.email} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <Avatar name={r.email} size={30} />
              <div className="flex-1 min-w-[180px] text-[0.85rem] text-[var(--color-ink-2)]">{r.email}</div>
              <GrantInline disabled={pending} onGrant={(role) => run(`grant:${r.email}`, () => grantAccessAction({ email: r.email, role }))} busy={busy === `grant:${r.email}`} />
            </div>
          ))}
        </div>
        <div className="border-t border-[var(--color-border)] px-5 py-4">
          <div className="text-[0.8rem] font-medium text-[var(--color-ink-2)] mb-2">Grant by email address</div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[220px]">
              <label className="label">Email</label>
              <input className="input" value={newEmail} placeholder="name@ajace.com" onChange={(e) => setNewEmail(e.target.value)} />
            </div>
            <div className="min-w-[160px]">
              <label className="label">Name (optional)</label>
              <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} />
            </div>
            <div>
              <label className="label">Role</label>
              <select className="input !w-auto" value={newRole} onChange={(e) => setNewRole(e.target.value as UserRole)}>
                {USER_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
            </div>
            <button
              className="btn btn-primary btn-sm"
              disabled={pending || !newEmail.trim()}
              onClick={() =>
                run("grant:new", async () => {
                  const res = await grantAccessAction({ email: newEmail, role: newRole, name: newName || undefined });
                  if (res.ok) { setNewEmail(""); setNewName(""); }
                  return res;
                })
              }
            >
              {busy === "grant:new" ? <Loader2 size={14} className="animate-spin" /> : "Grant access"}
            </button>
          </div>
          <p className="mt-2 text-[0.76rem] text-[var(--color-faint)]">
            Granting here does not create an AJACE login — the timesheet owns that. If the address can&apos;t
            sign in yet, you&apos;ll be told so.
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader title="Recent privilege changes" subtitle="Every grant, role change, revoke and deactivation, from this screen or the CLI." />
        <div className="divide-y divide-[var(--color-border)]">
          {log.length === 0 && <div className="px-5 py-5 text-[0.85rem] text-[var(--color-muted)]">No changes recorded yet.</div>}
          {log.map((l) => (
            <div key={l.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-5 py-2.5 text-[0.8rem]">
              <span className="font-mono text-[0.72rem] text-[var(--color-faint)] w-[120px]">
                {new Date(l.changed_at).toISOString().replace("T", " ").slice(0, 16)}
              </span>
              <span className="font-medium text-[var(--color-ink-2)] w-[92px]">{l.action}</span>
              <span className="text-[var(--color-ink)]">{l.target_email}</span>
              <span className="text-[var(--color-muted)]">
                {[l.old_value, l.new_value].filter(Boolean).join(" → ") || "—"}
              </span>
              <span className="text-[var(--color-faint)]">by {l.actor}</span>
              {l.reason && <span className="text-[var(--color-faint)] italic">{l.reason}</span>}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function GrantInline({ onGrant, disabled, busy }: { onGrant: (role: UserRole) => void; disabled: boolean; busy: boolean }) {
  const [role, setRole] = useState<UserRole>("viewer");
  return (
    <div className="flex items-center gap-2">
      <select className="input !w-auto !py-1 text-[0.8rem]" value={role} disabled={disabled} onChange={(e) => setRole(e.target.value as UserRole)}>
        {USER_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
      </select>
      <button className="btn btn-primary btn-sm" disabled={disabled} onClick={() => onGrant(role)}>
        {busy ? <Loader2 size={13} className="animate-spin" /> : "Grant"}
      </button>
    </div>
  );
}
