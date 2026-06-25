import type { CompanySettings } from "@/lib/types";
import type { RetrievedChunk } from "./rag";

export interface OppContext {
  externalId: string;
  title: string;
  agency: string | null;
  sourceName: string;
  state: string | null;
  category: string | null;
  dueDate: string | null;
  qaDeadline: string | null;
  description: string | null;
  /** Concatenated parsed attachment text (requirements), truncated. */
  attachmentsText: string | null;
}

function ctxBlock(ctx: OppContext): string {
  return [
    `Solicitation #: ${ctx.externalId}`,
    `Title: ${ctx.title}`,
    `Issuing agency: ${ctx.agency ?? "—"}`,
    `Portal: ${ctx.sourceName}${ctx.state ? ` (${ctx.state})` : ""}`,
    `Category/type: ${ctx.category ?? "—"}`,
    `Response due: ${ctx.dueDate ?? "—"}`,
    `Q&A deadline: ${ctx.qaDeadline ?? "—"}`,
    "",
    "Description / scope:",
    ctx.description ?? "(no description captured)",
    ctx.attachmentsText ? `\nRequirements excerpted from attachments:\n${ctx.attachmentsText}` : "",
  ].join("\n");
}

// ── Mode 1: style-matched ──────────────────────────────────────────────────
export function buildStyleMatchedPrompt(ctx: OppContext, retrieved: RetrievedChunk[], company: CompanySettings) {
  const examples = retrieved.length
    ? retrieved
        .map((r, i) => `--- Example ${i + 1} (${r.outcome}, "${r.title}") ---\n${r.content}`)
        .join("\n\n")
    : "(No past proposals on file yet — infer a confident, well-structured corporate voice.)";
  const system =
    `You are a senior proposal writer at ${company.name}. ${company.about} ` +
    `Write a procurement response that MIMICS the company's established voice, structure, ` +
    `and level of detail as shown in the example excerpts. Match their tone and formatting. ` +
    `Return clean Markdown with clear section headings.`;
  const user =
    `Draft a response to the following solicitation in ${company.name}'s established style.\n\n` +
    `${ctxBlock(ctx)}\n\n=== HOW WE WRITE (past proposal excerpts) ===\n${examples}\n\n` +
    `Produce a complete, submission-ready draft: executive summary, understanding of requirements, ` +
    `proposed approach, relevant experience, team, and why ${company.name}. Keep it specific to this solicitation.`;
  return { system, user };
}

// ── Mode 2: LLM-original ────────────────────────────────────────────────────
export function buildOriginalPrompt(ctx: OppContext, company: CompanySettings) {
  const system =
    `You are an expert proposal strategist. Write the strongest possible response to this ` +
    `solicitation using best practices for this solicitation type. You are NOT constrained to ` +
    `any past style — optimize purely for win probability, clarity, and compliance. Return clean Markdown.`;
  const user =
    `Write the best possible procurement response for ${company.name} to the following solicitation.\n\n` +
    `${ctxBlock(ctx)}\n\n` +
    `Include: a compelling executive summary, a compliance-mapped understanding of requirements, ` +
    `a differentiated technical approach, a realistic implementation plan with milestones, risk ` +
    `mitigation, relevant qualifications, and a clear value proposition. Be concrete and persuasive.`;
  return { system, user };
}

// ── Revision loop ───────────────────────────────────────────────────────────
export function buildRevisionPrompt(ctx: OppContext, current: string, instruction: string) {
  const system =
    `You are revising a procurement proposal draft. Apply the reviewer's instruction precisely while ` +
    `preserving everything else that works. Return the FULL revised draft in clean Markdown, not a diff.`;
  const user =
    `Solicitation context:\n${ctxBlock(ctx)}\n\n=== CURRENT DRAFT ===\n${current}\n\n` +
    `=== REVISION INSTRUCTION ===\n${instruction}\n\nReturn the complete revised draft.`;
  return { system, user };
}

// ── Deterministic mock renderers (used with no API key) ─────────────────────
function header(ctx: OppContext, company: CompanySettings, kind: string) {
  return (
    `# ${company.name} — Response to ${ctx.title}\n\n` +
    `**Solicitation:** ${ctx.externalId} · **Agency:** ${ctx.agency ?? "—"} · ` +
    `**Due:** ${ctx.dueDate ?? "—"}\n\n_${kind}_\n`
  );
}

export function mockStyleMatched(ctx: OppContext, retrieved: RetrievedChunk[], company: CompanySettings): string {
  const ref = retrieved[0];
  return `${header(ctx, company, "Style-matched draft modeled on prior winning proposals")}
## Executive Summary
${company.name} is pleased to submit this response to **${ctx.title}** (${ctx.externalId}) for ${ctx.agency ?? "the issuing agency"}. Drawing on our track record of delivering ${company.tagline.toLowerCase()}, we bring proven methods, a disciplined delivery model, and a partnership orientation tailored to ${ctx.state ?? "your"} public-sector needs.

## Understanding of Requirements
We understand this engagement centers on: ${ctx.description ? ctx.description.slice(0, 280) : "the scope outlined in the solicitation"}. Our reading of the requirements maps each stated objective to a concrete deliverable and a named owner.

## Our Approach
${ref ? `Consistent with the approach that succeeded in "${ref.title}", we` : "We"} phase the work to retire risk early: (1) discovery and requirements validation, (2) iterative delivery with agency checkpoints, (3) quality assurance and acceptance, and (4) transition and knowledge transfer.

## Relevant Experience
${ref ? ref.content.slice(0, 400) : `${company.name} has repeatedly delivered comparable scope on time and on budget for public agencies.`}

## Why ${company.name}
A right-sized, accountable team; transparent reporting; and a singular focus on outcomes the agency can measure.

> _Draft produced by the AJACE mock engine. Add an OPENROUTER_API_KEY to generate with a live model._`;
}

export function mockOriginal(ctx: OppContext, company: CompanySettings): string {
  return `${header(ctx, company, "LLM-original draft — best response from scratch")}
## Executive Summary
This proposal presents a focused, low-risk path for ${ctx.agency ?? "the agency"} to achieve the outcomes described in **${ctx.title}** (${ctx.externalId}). We optimize for compliance, schedule certainty, and measurable value.

## Compliance & Requirements Mapping
| Requirement (from solicitation) | Our response |
|---|---|
| Core scope | Fully addressed via our phased delivery model |
| Timeline to ${ctx.dueDate ?? "the stated deadline"} | Staffed plan with milestone checkpoints |
| Reporting & governance | Weekly status, risk register, agency steering cadence |

## Technical Approach
${ctx.description ? ctx.description.slice(0, 240) : "We propose a modular, standards-based solution"} delivered in increments, each independently demonstrable to the agency.

## Implementation Plan
1. **Weeks 1–2 — Mobilize & validate** requirements and success criteria.
2. **Weeks 3–8 — Iterative delivery** with biweekly demos.
3. **Weeks 9–10 — QA, acceptance, and transition.**

## Risk Mitigation
Early validation, fixed checkpoints, and a named escalation path keep delivery predictable.

## Value Proposition
${company.name} delivers ${company.tagline.toLowerCase()} with a disciplined, transparent, outcome-first model.

> _Draft produced by the AJACE mock engine. Add an OPENROUTER_API_KEY to generate with a live model._`;
}

export function mockRevision(current: string, instruction: string): string {
  return (
    `${current}\n\n---\n\n_Revision applied (mock): "${instruction}". With a live model this instruction ` +
    `is applied throughout the draft; the mock engine appends this note to preserve your iteration history._`
  );
}
