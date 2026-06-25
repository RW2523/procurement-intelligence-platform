import { Users, Building2, Bot, Target, Bell } from "lucide-react";
import { dbConfigured } from "@/lib/supabase/server";
import { config } from "@/lib/config";
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
          <CardHeader title={<span className="flex items-center gap-2"><Target size={16} /> Relevance & bid/no-bid</span>} subtitle="What counts as a fit" />
          <div className="p-5"><RelevanceForm initial={relevance} /></div>
        </Card>

        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><Bell size={16} /> Notifications</span>} subtitle="Deadline & Q&A reminder windows" />
          <div className="p-5"><NotificationForm initial={notifications} /></div>
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
