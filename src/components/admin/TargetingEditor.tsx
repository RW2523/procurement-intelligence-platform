"use client";

import { useState } from "react";
import { Save, Loader2, RefreshCw, FlaskConical } from "lucide-react";
import type { TargetingProfile, ScoreBreakdownEntry } from "@/lib/types";

/**
 * Structured editor for the five-dimension Targeting Profile. Lists are edited as
 * one-term-per-line textareas; weights/thresholds/bands as numeric inputs. Includes
 * a sandbox that scores a pasted title/description against the current (unsaved)
 * edits so changes can be tested before saving.
 */

const lines = (arr: string[]) => arr.join("\n");
const parseLines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="card p-5">
      <h3 className="text-[0.95rem] font-semibold text-[var(--color-ink)]">{title}</h3>
      {hint && <p className="text-[0.75rem] text-[var(--color-muted)] mt-0.5 mb-3">{hint}</p>}
      <div className="mt-3 space-y-3">{children}</div>
    </div>
  );
}

function NumField({ label, value, onChange, w = "w-20" }: { label: string; value: number; onChange: (n: number) => void; w?: string }) {
  return (
    <label className="inline-flex items-center gap-2 text-[0.8rem] text-[var(--color-ink-2)]">
      <span>{label}</span>
      <input
        type="number"
        className={`input ${w} !py-1`}
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
      />
    </label>
  );
}

export function TargetingEditor({ initial }: { initial: TargetingProfile }) {
  const [p, setP] = useState<TargetingProfile>(structuredClone(initial));
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [testTitle, setTestTitle] = useState("");
  const [testDesc, setTestDesc] = useState("");
  const [testResult, setTestResult] = useState<{
    pursuitScore: number;
    bucket: string;
    urgency: string;
    breakdown: ScoreBreakdownEntry[];
    excludedReason: string | null;
  } | null>(null);

  const set = (patch: Partial<TargetingProfile>) => setP((prev) => ({ ...prev, ...patch }));

  async function save() {
    setBusy("save");
    setMsg(null);
    try {
      const res = await fetch("/api/targeting", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: p, note: "Edited in Admin → Targeting" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setP(json.profile);
      setMsg(`Saved as version ${json.profile.version}. New crawls use it immediately — re-score to apply to stored opportunities.`);
    } catch (e) {
      setMsg(`Save failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function rescoreAll() {
    setBusy("rescore");
    setMsg("Re-scoring all opportunities…");
    try {
      let reset = true;
      let total = 0;
      for (let i = 0; i < 40; i++) {
        const res = await fetch("/api/targeting/rescore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ batch: 300, reset }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        reset = false;
        total += json.processed ?? 0;
        setMsg(`Re-scoring… ${total} done, ${json.remaining} remaining`);
        if (json.done) break;
      }
      setMsg(`Re-scored ${total} opportunities with the current profile.`);
    } catch (e) {
      setMsg(`Re-score failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function testProfile() {
    if (!testTitle.trim()) return;
    setBusy("test");
    setTestResult(null);
    try {
      const res = await fetch("/api/targeting/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: testTitle, description: testDesc, profile: p }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setTestResult(json.result);
    } catch (e) {
      setMsg(`Test failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5 max-w-4xl">
      {/* Sticky action bar */}
      <div className="card px-4 py-3 flex flex-wrap items-center gap-3 sticky top-2 z-10">
        <button className="btn btn-primary" onClick={save} disabled={busy !== null}>
          {busy === "save" ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save profile
        </button>
        <button className="btn btn-ghost" onClick={rescoreAll} disabled={busy !== null}>
          {busy === "rescore" ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Re-score everything
        </button>
        <span className="text-[0.75rem] text-[var(--color-muted)]">v{p.version}</span>
        {msg && <span className="text-[0.78rem] text-[var(--color-ink-2)]">{msg}</span>}
      </div>

      {/* Sandbox */}
      <Section title="Test the profile" hint="Paste a solicitation title/description and score it against your current edits (before saving).">
        <input className="input" placeholder="Solicitation title…" value={testTitle} onChange={(e) => setTestTitle(e.target.value)} />
        <textarea className="input resize-y" rows={3} placeholder="Description / scope (optional)…" value={testDesc} onChange={(e) => setTestDesc(e.target.value)} />
        <button className="btn btn-soft" onClick={testProfile} disabled={busy !== null || !testTitle.trim()}>
          {busy === "test" ? <Loader2 size={15} className="animate-spin" /> : <FlaskConical size={15} />} Score it
        </button>
        {testResult && (
          <div className="rounded-lg border border-[var(--color-border)] p-3 text-[0.83rem]">
            <div className="font-semibold text-[var(--color-ink)] mb-1">
              Score {testResult.pursuitScore} → {testResult.bucket.replace("_", " ")}
              {testResult.excludedReason ? ` · excluded by "${testResult.excludedReason}"` : ""}
            </div>
            <ul className="space-y-0.5 text-[var(--color-ink-2)]">
              {testResult.breakdown.map((b, i) => (
                <li key={i}>
                  <span className="font-medium">{b.points > 0 ? `+${b.points}` : b.points}</span> {b.criterion}
                  <span className="text-[var(--color-faint)]"> — {b.matched.slice(0, 4).join(", ")}</span>
                </li>
              ))}
              {!testResult.breakdown.length && <li className="text-[var(--color-faint)]">No criteria matched.</li>}
            </ul>
          </div>
        )}
      </Section>

      {/* Thresholds + date bands */}
      <Section title="Thresholds & date rules" hint="§9 buckets and the §10 due-date rule (calendar days).">
        <div className="flex flex-wrap gap-4">
          <NumField label="Pursue ≥" value={p.thresholds.pursue} onChange={(n) => set({ thresholds: { ...p.thresholds, pursue: n } })} />
          <NumField label="Capture review ≥" value={p.thresholds.captureReview} onChange={(n) => set({ thresholds: { ...p.thresholds, captureReview: n } })} />
          <NumField label="Manual review ≥" value={p.thresholds.manualReview} onChange={(n) => set({ thresholds: { ...p.thresholds, manualReview: n } })} />
        </div>
        <div className="flex flex-wrap gap-4">
          <NumField label="Min days to respond" value={p.dateBands.minDays} onChange={(n) => set({ dateBands: { ...p.dateBands, minDays: n } })} />
          <NumField label="Urgent ≤ days" value={p.dateBands.urgentMax} onChange={(n) => set({ dateBands: { ...p.dateBands, urgentMax: n } })} />
          <NumField label="Standard ≤ days" value={p.dateBands.standardMax} onChange={(n) => set({ dateBands: { ...p.dateBands, standardMax: n } })} />
        </div>
      </Section>

      {/* Dimension 2a: capabilities */}
      <Section title="Capability groups (Dimension 2)" hint="One phrase per line. Each group scores its points once per opportunity, no matter how many phrases match.">
        {p.capabilities.map((g, i) => (
          <div key={g.key} className="rounded-lg border border-[var(--color-border)] p-3">
            <div className="flex items-center justify-between gap-3 mb-2">
              <span className="text-[0.85rem] font-medium text-[var(--color-ink)]">{g.label}</span>
              <NumField
                label="pts"
                value={g.points}
                onChange={(n) => {
                  const caps = [...p.capabilities];
                  caps[i] = { ...g, points: n };
                  set({ capabilities: caps });
                }}
              />
            </div>
            <textarea
              className="input resize-y font-mono text-[0.78rem]"
              rows={Math.min(6, Math.max(2, Math.ceil(g.phrases.length / 2)))}
              value={lines(g.phrases)}
              onChange={(e) => {
                const caps = [...p.capabilities];
                caps[i] = { ...g, phrases: parseLines(e.target.value) };
                set({ capabilities: caps });
              }}
            />
          </div>
        ))}
      </Section>

      {/* Functional areas */}
      <Section title="Government functional areas (Dimension 1)" hint="Supporting signals for opportunities that aren't described by technology.">
        <NumField label="Points" value={p.functionalAreas.points} onChange={(n) => set({ functionalAreas: { ...p.functionalAreas, points: n } })} />
        <textarea
          className="input resize-y font-mono text-[0.78rem]"
          rows={4}
          value={lines(p.functionalAreas.phrases)}
          onChange={(e) => set({ functionalAreas: { ...p.functionalAreas, phrases: parseLines(e.target.value) } })}
        />
      </Section>

      {/* Labor categories + technologies */}
      <Section title="Labor categories & technologies (Dimension 2)" hint={`Format: "Term -> group_key". Matches award the parent group's points. Group keys: ${p.capabilities.map((c) => c.key).join(", ")}`}>
        <label className="label">Labor categories</label>
        <textarea
          className="input resize-y font-mono text-[0.78rem]"
          rows={6}
          value={p.laborCategories.map((l) => `${l.title} -> ${l.group}`).join("\n")}
          onChange={(e) =>
            set({
              laborCategories: parseLines(e.target.value)
                .map((line) => {
                  const [title, group] = line.split("->").map((x) => x.trim());
                  return title && group ? { title, group } : null;
                })
                .filter((x): x is { title: string; group: string } => x !== null),
            })
          }
        />
        <label className="label">Technologies</label>
        <textarea
          className="input resize-y font-mono text-[0.78rem]"
          rows={6}
          value={p.technologies.map((t) => `${t.term} -> ${t.group}`).join("\n")}
          onChange={(e) =>
            set({
              technologies: parseLines(e.target.value)
                .map((line) => {
                  const [term, group] = line.split("->").map((x) => x.trim());
                  return term && group ? { term, group } : null;
                })
                .filter((x): x is { term: string; group: string } => x !== null),
            })
          }
        />
      </Section>

      {/* Vehicles */}
      <Section title="Contract vehicles (Dimension 3)">
        <div className="flex flex-wrap gap-4">
          <NumField label="GSA MAS pts" value={p.vehicles.gsaMasPoints} onChange={(n) => set({ vehicles: { ...p.vehicles, gsaMasPoints: n } })} />
          <NumField label="Other vehicle pts" value={p.vehicles.otherPoints} onChange={(n) => set({ vehicles: { ...p.vehicles, otherPoints: n } })} />
        </div>
        <label className="label">GSA terms</label>
        <textarea className="input resize-y font-mono text-[0.78rem]" rows={2} value={lines(p.vehicles.gsaTerms)} onChange={(e) => set({ vehicles: { ...p.vehicles, gsaTerms: parseLines(e.target.value) } })} />
        <label className="label">Other vehicle terms</label>
        <textarea className="input resize-y font-mono text-[0.78rem]" rows={2} value={lines(p.vehicles.otherTerms)} onChange={(e) => set({ vehicles: { ...p.vehicles, otherTerms: parseLines(e.target.value) } })} />
        <label className="label">Solicitation types (Term: points)</label>
        <textarea
          className="input resize-y font-mono text-[0.78rem]"
          rows={3}
          value={p.solicitationTypes.map((s) => `${s.term}: ${s.points}`).join("\n")}
          onChange={(e) =>
            set({
              solicitationTypes: parseLines(e.target.value)
                .map((line) => {
                  const [term, pts] = line.split(":").map((x) => x.trim());
                  return term ? { term, points: Number(pts) || 0 } : null;
                })
                .filter((x): x is { term: string; points: number } => x !== null),
            })
          }
        />
      </Section>

      {/* Set-asides */}
      <Section title="Socioeconomic set-asides (Dimension 4)" hint="AJACE is SBA-certified 8(a), WOSB, and MBE — these tiers get the strongest boosts.">
        {p.setAsides.map((tier, i) => (
          <div key={tier.label} className="rounded-lg border border-[var(--color-border)] p-3">
            <div className="flex items-center justify-between gap-3 mb-2">
              <span className="text-[0.85rem] font-medium text-[var(--color-ink)]">{tier.label}</span>
              <NumField
                label="pts"
                value={tier.points}
                onChange={(n) => {
                  const arr = [...p.setAsides];
                  arr[i] = { ...tier, points: n };
                  set({ setAsides: arr });
                }}
              />
            </div>
            <textarea
              className="input resize-y font-mono text-[0.78rem]"
              rows={1}
              value={lines(tier.terms)}
              onChange={(e) => {
                const arr = [...p.setAsides];
                arr[i] = { ...tier, terms: parseLines(e.target.value) };
                set({ setAsides: arr });
              }}
            />
          </div>
        ))}
      </Section>

      {/* Agencies */}
      <Section title="Priority agencies" hint='Federal format: "Name | alias1; alias2" — append " | IT-ONLY" for the DoD rule. States: one per line.'>
        <div className="flex flex-wrap gap-4">
          <NumField label="Federal pts" value={p.agencies.federalPoints} onChange={(n) => set({ agencies: { ...p.agencies, federalPoints: n } })} />
          <NumField label="State pts" value={p.agencies.statePoints} onChange={(n) => set({ agencies: { ...p.agencies, statePoints: n } })} />
        </div>
        <label className="label">Federal agencies</label>
        <textarea
          className="input resize-y font-mono text-[0.78rem]"
          rows={8}
          value={p.agencies.federal.map((f) => `${f.name} | ${f.aliases.join("; ")}${f.itOnly ? " | IT-ONLY" : ""}`).join("\n")}
          onChange={(e) =>
            set({
              agencies: {
                ...p.agencies,
                federal: parseLines(e.target.value)
                  .map((line) => {
                    const parts = line.split("|").map((x) => x.trim());
                    if (!parts[0]) return null;
                    const itOnly = parts.some((x) => x.toUpperCase() === "IT-ONLY");
                    const aliases = (parts[1] ?? "").split(";").map((x) => x.trim()).filter((x) => x && x.toUpperCase() !== "IT-ONLY");
                    return { name: parts[0], aliases, ...(itOnly ? { itOnly: true } : {}) };
                  })
                  .filter((x): x is { name: string; aliases: string[]; itOnly?: boolean } => x !== null),
              },
            })
          }
        />
        <label className="label">Priority states</label>
        <textarea
          className="input resize-y font-mono text-[0.78rem]"
          rows={4}
          value={lines(p.agencies.states)}
          onChange={(e) => set({ agencies: { ...p.agencies, states: parseLines(e.target.value) } })}
        />
      </Section>

      {/* Exclusions */}
      <Section title="Exclude keywords (Dimension 5)" hint="An exclusion only fires when NO technical capability matched — 'IT Modernization of HVAC systems' survives.">
        {p.exclusions.map((ex, i) => (
          <div key={ex.group}>
            <label className="label">{ex.group}</label>
            <textarea
              className="input resize-y font-mono text-[0.78rem]"
              rows={2}
              value={lines(ex.terms)}
              onChange={(e) => {
                const arr = [...p.exclusions];
                arr[i] = { ...ex, terms: parseLines(e.target.value) };
                set({ exclusions: arr });
              }}
            />
          </div>
        ))}
      </Section>

      {/* NAICS + value bands */}
      <Section title="NAICS & estimated value">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex-1 min-w-[240px]">
            <label className="label">Target NAICS codes (prefix match)</label>
            <input
              className="input font-mono text-[0.8rem]"
              value={p.naics.codes.join(", ")}
              onChange={(e) => set({ naics: { ...p.naics, codes: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) } })}
            />
          </div>
          <NumField label="NAICS pts" value={p.naics.points} onChange={(n) => set({ naics: { ...p.naics, points: n } })} />
        </div>
        <label className="label">Value bands (upper bound → points; blank bound = no ceiling)</label>
        <div className="space-y-1.5">
          {p.valueBands.map((b, i) => (
            <div key={i} className="flex items-center gap-3 text-[0.8rem]">
              <span className="w-24 text-[var(--color-muted)]">{b.label}</span>
              <NumField
                label="pts"
                value={b.points}
                onChange={(n) => {
                  const arr = [...p.valueBands];
                  arr[i] = { ...b, points: n };
                  set({ valueBands: arr });
                }}
              />
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
