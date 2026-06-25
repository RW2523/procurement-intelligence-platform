"use client";

import { useState, useTransition, useRef } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Upload, Check } from "lucide-react";
import { createKnowledgeAction } from "@/app/actions";
import type { KnowledgeOutcome } from "@/lib/types";

export function KnowledgeForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const [done, setDone] = useState<string | null>(null);
  const [form, setForm] = useState({
    title: "",
    outcome: "won" as KnowledgeOutcome,
    category: "",
    tags: "",
    text: "",
  });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setForm((f) => ({
        ...f,
        text: String(reader.result ?? ""),
        title: f.title || file.name.replace(/\.[^.]+$/, ""),
      }));
    };
    reader.readAsText(file);
  }

  function submit() {
    if (!form.title || !form.text.trim()) return;
    start(async () => {
      const res = await createKnowledgeAction({
        title: form.title,
        parsed_text: form.text,
        outcome: form.outcome,
        category: form.category || undefined,
        tags: form.tags ? form.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
      });
      setDone(`Embedded into ${res.chunks} chunks`);
      setForm({ title: "", outcome: "won", category: "", tags: "", text: "" });
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
      setTimeout(() => setDone(null), 4000);
    });
  }

  return (
    <div className="card p-5 space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="label">Title</label>
          <input className="input" value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="2025 City of Raleigh CRM Proposal" />
        </div>
        <div>
          <label className="label">Outcome</label>
          <select className="input" value={form.outcome} onChange={(e) => set("outcome", e.target.value)}>
            <option value="won">Won</option>
            <option value="lost">Lost</option>
            <option value="unknown">Unknown</option>
          </select>
        </div>
        <div>
          <label className="label">Category</label>
          <input className="input" value={form.category} onChange={(e) => set("category", e.target.value)} placeholder="Software / IT services" />
        </div>
        <div>
          <label className="label">Tags (comma-separated)</label>
          <input className="input" value={form.tags} onChange={(e) => set("tags", e.target.value)} placeholder="crm, cloud, govtech" />
        </div>
      </div>
      <div>
        <label className="label">Proposal text</label>
        <textarea className="input min-h-[160px] font-mono text-[0.8rem]" value={form.text} onChange={(e) => set("text", e.target.value)} placeholder="Paste a past proposal, or upload a .txt / .md file below. This teaches the AI your voice (RAG)." />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input ref={fileRef} type="file" accept=".txt,.md,.markdown,.csv,.json" onChange={onFile} className="text-[0.8rem]" />
        <button className="btn btn-primary ml-auto" disabled={pending || !form.title || !form.text.trim()} onClick={submit}>
          {pending ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />} Add to library
        </button>
        {done && <span className="text-[0.8rem] text-[var(--color-mint-700)] flex items-center gap-1"><Check size={14} /> {done}</span>}
      </div>
    </div>
  );
}
