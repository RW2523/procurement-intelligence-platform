import Link from "next/link";
import { Users, Building2, Bot, Target, Bell, KeyRound } from "lucide-react";
import { dbConfigured } from "@/lib/supabase/server";
import { config } from "@/lib/config";
import { can } from "@/lib/auth/guard";
import { getCurrentUser } from "@/lib/db/users";
import { AdminOnly } from "@/components/AdminOnly";
import {
  getAISettings,
  getCompanySettings,
  getRelevanceSettings,
  getNotificationSettings,
} from "@/lib/db/settings";
import { listUsers } from "@/lib/db/users";
import { Card, CardHeader, PageHeader, Badge, Avatar } from "@/components/ui";
import {
  AISettingsForm,
  CompanyForm,
  RelevanceForm,
  NotificationForm,
} from "@/components/admin/SettingsForms";
import { SetupNotice } from "@/components/SetupNotice";
import { titleCase } from "@/lib/utils";

export const dynamic = "force-dynamic";

const ROLE_STYLE: Record<string, { bg: string; fg: string }> = {
  admin: { bg: "var(--color-brand-50)", fg: "var(--color-brand-700)" },
  writer: { bg: "var(--color-violet-100)", fg: "#6d28d9" },
  approver: { bg: "var(--color-mint-100)", fg: "var(--color-mint-700)" },
  viewer: { bg: "#eef0f4", fg: "#5b6170" },
};

export default async function AdminPage() {
  if (!dbConfigured) {
    return (
      <>
        <PageHeader title="Admin" subtitle="Users, AI, relevance & notifications" />
        <SetupNotice />
      </>
    );
  }
  // This screen edits AI keys, scoring thresholds and the user list, and every
  // form on it posts to an action that already demands admin — but the page
  // itself used to render for any signed-in procurement user, handing viewers a
  // full read of settings and the staff roster. Gate it the same way
  // /admin/access does: check, then render a refusal rather than throwing.
  const me = await getCurrentUser();
  if (!me || !can(me, "admin")) return <AdminOnly user={me} />;

  const [ai, company, relevance, notifications, users] = await Promise.all([
    getAISettings(),
    getCompanySettings(),
    getRelevanceSettings(),
    getNotificationSettings(),
    listUsers(),
  ]);

  return (
    <>
      <PageHeader title="Admin" subtitle="Users & roles · AI · relevance · notifications" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><Building2 size={16} /> Company</span>} subtitle="Branding & AI persona" />
          <div className="p-5"><CompanyForm initial={company} /></div>
        </Card>

        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><Bot size={16} /> AI settings</span>} subtitle="Models via OpenRouter (config-driven)" />
          <div className="p-5"><AISettingsForm initial={ai} live={config.llm.live} /></div>
        </Card>

        <Card>
          {/* These two use <Link>, not <a>. Next rewrites Link hrefs for the
              /procurement basePath; a bare <a href="/admin/..."> does not get
              rewritten and escapes to the site root (the timesheet app), 404ing. */}
          <CardHeader
            title={<span className="flex items-center gap-2"><Target size={16} /> Targeting profile</span>}
            subtitle="The five-dimension search engine: capabilities, vehicles, set-asides, agencies, exclusions, weights & thresholds"
            action={<Link href="/admin/targeting" className="btn btn-primary btn-sm">Open editor</Link>}
          />
          <div className="p-5 text-[0.83rem] text-[var(--color-muted)]">
            The weighted targeting engine scores every crawled and uploaded opportunity
            (Pursue ≥80 · Capture review 60–79 · Manual review 40–59 · Ignore &lt;40) and enforces
            the ≥10-day response window. Edit keywords, points, and thresholds in the editor —
            no code changes needed — then re-score everything with one click.
          </div>
        </Card>

        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><Target size={16} /> Relevance & bid/no-bid</span>} subtitle="Legacy keyword fit (superseded by the targeting profile)" />
          <div className="p-5"><RelevanceForm initial={relevance} /></div>
        </Card>

        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><Bell size={16} /> Notifications</span>} subtitle="Deadline & Q&A reminder windows" />
          <div className="p-5"><NotificationForm initial={notifications} /></div>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader
            title={<span className="flex items-center gap-2"><KeyRound size={16} /> Access & roles</span>}
            subtitle="Grant or revoke Procurement access for anyone with an AJACE login, change roles, and deactivate accounts"
            action={<Link href="/admin/access" className="btn btn-primary btn-sm">Manage access</Link>}
          />
          <div className="p-5 text-[0.83rem] text-[var(--color-muted)]">
            One AJACE login covers the timesheet and this app, but Procurement needs a role on top of it —
            that is why someone can sign in and still land on “You don&apos;t have access”. Grant it here, or
            from the server with <code className="font-mono text-[0.78rem]">npm run access -- grant name@ajace.com --role writer --yes</code>.
            Every change is audited.
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title={<span className="flex items-center gap-2"><Users size={16} /> Users & roles</span>} subtitle="Writers draft · approvers approve · viewers view · admins configure" />
          <div className="divide-y divide-[var(--color-border)]">
            {users.map((u) => {
              const rs = ROLE_STYLE[u.role];
              return (
                <div key={u.id} className="flex items-center gap-3 px-5 py-3">
                  <Avatar name={u.name} size={34} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[0.88rem] font-medium text-[var(--color-ink)]">{u.name}</div>
                    <div className="text-[0.76rem] text-[var(--color-faint)]">{u.email}</div>
                  </div>
                  <Badge label={titleCase(u.role)} bg={rs.bg} fg={rs.fg} />
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    </>
  );
}
