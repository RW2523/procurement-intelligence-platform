"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Save, AlertTriangle } from "lucide-react";
import { createSourceAction } from "@/app/actions";
import type { ConnectorType } from "@/lib/types";

const CONNECTOR_TYPES: ConnectorType[] = ["json_api", "static_html", "aspnet_viewstate", "jsf_playwright", "playwright", "custom"];
const KNOWN_KEYS = ["nc", "tn", "ar", "pa", "ma"];

export function AddSourceForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    slug: "",
    state: "",
    base_url: "",
    connector_type: "static_html" as ConnectorType,
    connector_key: "",
    schedule_cron: "0 6 * * *",
    timezone: "America/New_York",
    requires_auth: false,
    notes: "",
  });

  const set = (k: keyof typeof form, v: unknown) => setForm((f) => ({ ...f, [k]: v }));
  const connectorMissing = form.connector_key !== "" && !KNOWN_KEYS.includes(form.connector_key);

  function submit() {
    setError(null);
    if (!form.name || !form.slug || !form.base_url) {
      setError("Name, slug and base URL are required.");
      return;
    }
    start(async () => {
      try {
        await createSourceAction({
          name: form.name,
          slug: form.slug.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
          state: form.state || undefined,
          base_url: form.base_url,
          connector_type: form.connector_type,
          connector_key: form.connector_key || undefined,
          schedule_cron: form.schedule_cron,
          timezone: form.timezone,
          requires_auth: form.requires_auth,
          notes: form.notes || undefined,
        });
        router.push("/sources");
      } catch (e) {
        setError((e as Error).message);
      }
    });
  }

  return (
    <div className="card p-6 max-w-2xl space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Portal name *"><input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Georgia Procurement Registry" /></Field>
        <Field label="Slug *"><input className="input font-mono" value={form.slug} onChange={(e) => set("slug", e.target.value)} placeholder="ga" /></Field>
        <Field label="State"><input className="input" value={form.state} onChange={(e) => set("state", e.target.value)} placeholder="GA" /></Field>
        <Field label="Timezone"><input className="input" value={form.timezone} onChange={(e) => set("timezone", e.target.value)} /></Field>
      </div>

      <Field label="Base URL *"><input className="input" value={form.base_url} onChange={(e) => set("base_url", e.target.value)} placeholder="https://ssl.doas.state.ga.us/PRSapp/PR_index.jsp" /></Field>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Connector type">
          <select className="input" value={form.connector_type} onChange={(e) => set("connector_type", e.target.value)}>
            {CONNECTOR_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Connector key (code module)">
          <input className="input font-mono" value={form.connector_key} onChange={(e) => set("connector_key", e.target.value)} placeholder="ga" />
        </Field>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Crawl schedule (cron)"><input className="input font-mono" value={form.schedule_cron} onChange={(e) => set("schedule_cron", e.target.value)} /></Field>
        <Field label="Requires login">
          <label className="flex items-center gap-2 h-9 text-[0.85rem] text-[var(--color-ink-2)]">
            <input type="checkbox" className="accent-[var(--color-brand-600)]" checked={form.requires_auth} onChange={(e) => set("requires_auth", e.target.checked)} />
            Portal needs credentials (stored in a secrets vault, never plaintext)
          </label>
        </Field>
      </div>

      <Field label="Notes"><textarea className="input min-h-[70px]" value={form.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Tech stack, quirks, anything engineering should know." /></Field>

      {connectorMissing && (
        <div className="flex items-start gap-2 text-[0.8rem] text-[var(--color-amber-700)] bg-[var(--color-amber-100)] rounded-lg px-3 py-2">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          No connector module is registered for <code className="font-mono">{form.connector_key}</code>. The portal will be saved
          as <strong>“needs connector”</strong> so engineering knows to build one. Existing connectors: {KNOWN_KEYS.join(", ")}.
        </div>
      )}
      {error && <div className="text-[0.82rem] text-[var(--color-rose-700)]">{error}</div>}

      <div className="flex items-center gap-2 pt-1">
        <button className="btn btn-primary" disabled={pending} onClick={submit}>
          {pending ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Add portal
        </button>
        <button className="btn btn-ghost" onClick={() => router.push("/sources")}>Cancel</button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
    </div>
  );
}
