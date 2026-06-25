"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Check } from "lucide-react";
import { updateSettingAction } from "@/app/actions";
import type { AISettings, CompanySettings, NotificationSettings, RelevanceSettings } from "@/lib/types";

function useSaver(key: string) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const save = (value: unknown) =>
    start(async () => {
      await updateSettingAction(key, value);
      router.refresh();
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    });
  return { pending, saved, save };
}

function SaveBar({ pending, saved, onClick }: { pending: boolean; saved: boolean; onClick: () => void }) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <button className="btn btn-primary btn-sm" disabled={pending} onClick={onClick}>
        {pending ? <Loader2 size={14} className="animate-spin" /> : "Save"}
      </button>
      {saved && <span className="text-[0.78rem] text-[var(--color-mint-700)] flex items-center gap-1"><Check size={13} /> Saved</span>}
    </div>
  );
}

export function CompanyForm({ initial }: { initial: CompanySettings }) {
  const { pending, saved, save } = useSaver("company");
  const [f, setF] = useState(initial);
  return (
    <div className="space-y-3">
      <div><label className="label">Company name</label><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
      <div><label className="label">Tagline</label><input className="input" value={f.tagline} onChange={(e) => setF({ ...f, tagline: e.target.value })} /></div>
      <div><label className="label">About (used in AI prompts)</label><textarea className="input min-h-[70px]" value={f.about} onChange={(e) => setF({ ...f, about: e.target.value })} /></div>
      <SaveBar pending={pending} saved={saved} onClick={() => save(f)} />
    </div>
  );
}

export function AISettingsForm({ initial, live }: { initial: AISettings; live: boolean }) {
  const { pending, saved, save } = useSaver("ai");
  const [f, setF] = useState(initial);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[0.8rem]">
        <span className="badge" style={{ background: live ? "var(--color-mint-100)" : "var(--color-amber-100)", color: live ? "var(--color-mint-700)" : "var(--color-amber-700)" }}>
          {live ? "Live model connected" : "Mock engine (no key)"}
        </span>
        <span className="text-[var(--color-faint)]">via OpenRouter</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><label className="label">Generation model (proposals)</label><input className="input font-mono" value={f.generation_model} onChange={(e) => setF({ ...f, generation_model: e.target.value })} /></div>
        <div><label className="label">Draft model (cheap)</label><input className="input font-mono" value={f.draft_model} onChange={(e) => setF({ ...f, draft_model: e.target.value })} /></div>
        <div><label className="label">Summary / scoring model</label><input className="input font-mono" value={f.summary_model} onChange={(e) => setF({ ...f, summary_model: e.target.value })} /></div>
        <div><label className="label">Temperature</label><input className="input" type="number" step="0.1" min="0" max="1" value={f.temperature} onChange={(e) => setF({ ...f, temperature: Number(e.target.value) })} /></div>
      </div>
      <label className="flex items-center gap-2 text-[0.85rem] text-[var(--color-ink-2)]">
        <input type="checkbox" className="accent-[var(--color-brand-600)]" checked={f.auto_draft} onChange={(e) => setF({ ...f, auto_draft: e.target.checked })} />
        Auto-draft high-relevance opportunities on discovery
      </label>
      <SaveBar pending={pending} saved={saved} onClick={() => save(f)} />
    </div>
  );
}

export function RelevanceForm({ initial }: { initial: RelevanceSettings }) {
  const { pending, saved, save } = useSaver("relevance");
  const [keywords, setKeywords] = useState(initial.keywords.join(", "));
  const [naics, setNaics] = useState(initial.naics.join(", "));
  const [threshold, setThreshold] = useState(initial.auto_draft_threshold);
  return (
    <div className="space-y-3">
      <div><label className="label">Keywords (bid/no-bid scoring)</label><textarea className="input min-h-[60px]" value={keywords} onChange={(e) => setKeywords(e.target.value)} /></div>
      <div><label className="label">Target NAICS codes</label><input className="input font-mono" value={naics} onChange={(e) => setNaics(e.target.value)} /></div>
      <div><label className="label">Strong-fit threshold ({threshold})</label><input type="range" min="0" max="100" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} className="w-full accent-[var(--color-brand-600)]" /></div>
      <SaveBar
        pending={pending}
        saved={saved}
        onClick={() =>
          save({
            keywords: keywords.split(",").map((s) => s.trim()).filter(Boolean),
            naics: naics.split(",").map((s) => s.trim()).filter(Boolean),
            min_value: initial.min_value,
            auto_draft_threshold: threshold,
          })
        }
      />
    </div>
  );
}

export function NotificationForm({ initial }: { initial: NotificationSettings }) {
  const { pending, saved, save } = useSaver("notifications");
  const [f, setF] = useState({
    deadline: initial.deadline_reminder_days.join(", "),
    qa: initial.qa_reminder_days.join(", "),
    email: initial.email_enabled,
    slack: initial.slack_enabled,
  });
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div><label className="label">Deadline reminders (days before)</label><input className="input font-mono" value={f.deadline} onChange={(e) => setF({ ...f, deadline: e.target.value })} /></div>
        <div><label className="label">Q&A reminders (days before)</label><input className="input font-mono" value={f.qa} onChange={(e) => setF({ ...f, qa: e.target.value })} /></div>
      </div>
      <div className="flex gap-4">
        <label className="flex items-center gap-2 text-[0.85rem]"><input type="checkbox" className="accent-[var(--color-brand-600)]" checked={f.email} onChange={(e) => setF({ ...f, email: e.target.checked })} /> Email alerts</label>
        <label className="flex items-center gap-2 text-[0.85rem]"><input type="checkbox" className="accent-[var(--color-brand-600)]" checked={f.slack} onChange={(e) => setF({ ...f, slack: e.target.checked })} /> Slack alerts</label>
      </div>
      <SaveBar
        pending={pending}
        saved={saved}
        onClick={() =>
          save({
            deadline_reminder_days: f.deadline.split(",").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n)),
            qa_reminder_days: f.qa.split(",").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n)),
            email_enabled: f.email,
            slack_enabled: f.slack,
          })
        }
      />
    </div>
  );
}
