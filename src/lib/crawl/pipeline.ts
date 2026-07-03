import { getServiceClient } from "@/lib/supabase/server";
import { getConnector } from "@/lib/connectors/registry";
import { getCompanySettings } from "@/lib/db/settings";
import { classifyRelevanceLLM, buildProfileFromTargeting } from "@/lib/ai/relevance";
import { getTargetingProfile } from "@/lib/targeting/profile";
import { scoreOpportunity, type EngineResult } from "@/lib/targeting/engine";
import { contentHash, fallbackExternalId } from "./hash";
import { fetchOpportunityDocuments } from "./attachments";
import { fmtDate } from "@/lib/utils";
import type { NormalizedOpportunity, Source } from "@/lib/types";

export interface CrawlSummary {
  sourceId: string;
  sourceName: string;
  runId: string | null;
  status: "success" | "partial" | "failed";
  itemsFound: number;
  newCount: number;
  changedCount: number;
  closedCount: number;
  errorCount: number;
  methodUsed: string;
  warnings: string[];
  durationMs: number;
  error?: string;
}

export interface CrawlOptions {
  trigger?: "manual" | "scheduled";
  limit?: number;
  signal?: AbortSignal;
}

const nowISO = () => new Date().toISOString();

/**
 * The §4 daily-crawl pipeline for one source: fetch → normalize → match → decide
 * (NEW / unchanged / AMENDED) → reconcile statuses of items no longer listed →
 * log the run. Unchanged opportunities are touched but never re-processed.
 */
export async function runCrawlForSource(source: Source, opts: CrawlOptions = {}): Promise<CrawlSummary> {
  const sb = getServiceClient();
  const startedAt = Date.now();
  const warnings: string[] = [];
  const notes: string[] = [];
  let methodUsed = "";
  let itemsFound = 0;
  let newCount = 0;
  let changedCount = 0;
  let closedCount = 0;

  const { data: run } = await sb
    .from("crawl_runs")
    .insert({ source_id: source.id, trigger: opts.trigger ?? "manual", status: "running" })
    .select("id")
    .single();
  const runId = run?.id ?? null;

  try {
    const connector = getConnector(source.connector_key);
    if (!connector) {
      await sb.from("sources").update({ status: "needs_connector" }).eq("id", source.id);
      throw new Error(`No connector registered for key "${source.connector_key ?? "(none)"}"`);
    }

    const targeting = await getTargetingProfile();
    const result = await connector.fetchOpenOpportunities({ limit: opts.limit, signal: opts.signal });
    methodUsed = result.methodUsed;
    warnings.push(...result.warnings);
    itemsFound = result.opportunities.length;

    const { data: existingRows } = await sb
      .from("opportunities")
      .select("id, external_id, content_hash, status, due_date")
      .eq("source_id", source.id);
    const existing = new Map((existingRows ?? []).map((r) => [r.external_id, r]));
    const seen = new Set<string>();
    // New / amended items to send through the LLM bid-no-bid check after the loop.
    const toScore: { id: string; o: NormalizedOpportunity; engine: EngineResult }[] = [];

    for (const o of result.opportunities) {
      const externalId = o.externalId?.trim() || fallbackExternalId(o);
      seen.add(externalId);
      const hash = contentHash(o);
      const ex = existing.get(externalId);
      // ── Weighted targeting engine (five dimensions, deterministic, zero tokens) ──
      const engine = scoreOpportunity(
        {
          title: o.title,
          description: o.description,
          category: o.category,
          agency: o.agency,
          naicsCode: o.naicsCode,
          dueDate: o.dueDate ?? null,
          estimatedValue: o.estimatedValue ?? null,
          sourceState: source.state,
        },
        targeting,
      );
      const engineSummary = engine.excludedReason
        ? `Excluded: ${engine.excludedReason}`
        : engine.breakdown
            .filter((b) => b.points > 0)
            .slice(0, 4)
            .map((b) => `${b.criterion} +${b.points}`)
            .join(" · ") || "No targeting criteria matched";
      const fields = {
        title: o.title,
        agency: o.agency ?? null,
        category: o.category ?? null,
        naics_code: o.naicsCode ?? null,
        description: o.description ?? null,
        posted_date: o.postedDate ? o.postedDate.slice(0, 10) : null,
        due_date: o.dueDate ?? null,
        q_and_a_deadline: o.qAndADeadline ?? null,
        estimated_value: o.estimatedValue ?? null,
        detail_url: o.detailUrl ?? null,
        relevance_score: Math.min(100, engine.pursuitScore),
        relevance_reason: engineSummary,
        relevance_method: "engine",
        pursuit_score: engine.pursuitScore,
        pursuit_bucket: engine.bucket,
        urgency: engine.urgency,
        set_asides: engine.setAsides,
        contract_vehicle: engine.contractVehicle,
        solicitation_type: engine.solicitationType,
        agency_priority: engine.agencyPriority,
        excluded_reason: engine.excludedReason,
        score_breakdown: engine.breakdown as unknown as Record<string, unknown>[],
        content_hash: hash,
      };

      if (!ex) {
        // ── NEW ──────────────────────────────────────────────────────────────
        const { data: inserted, error } = await sb
          .from("opportunities")
          .insert({ source_id: source.id, external_id: externalId, status: "NEW", ...fields })
          .select("id")
          .single();
        if (error || !inserted) {
          warnings.push(`Insert failed for ${externalId}: ${error?.message}`);
          continue;
        }
        const oppId = inserted.id;
        newCount++;
        toScore.push({ id: oppId, o, engine });
        await sb.from("opportunity_versions").insert({
          opportunity_id: oppId,
          version_no: 1,
          snapshot_json: o as unknown as Record<string, unknown>,
          content_hash: hash,
          change_summary: "Initial capture",
        });
        await sb.from("opportunity_status_log").insert({
          opportunity_id: oppId,
          field: "status",
          old_value: null,
          new_value: "NEW",
          changed_by: "system",
          reason: "First seen on portal",
        });
        if (o.attachmentUrls?.length) {
          await sb.from("attachments").insert(
            o.attachmentUrls.slice(0, 30).map((a) => ({
              opportunity_id: oppId,
              filename: a.filename || "attachment",
              source_url: a.url,
              parse_status: "pending",
            })),
          );
        }
        // Notify per bucket: PURSUE (≥80, due ≥10 days, not excluded) is the loud one.
        if (engine.bucket === "PURSUE" && engine.urgency !== "INSUFFICIENT_TIME") {
          await sb.from("notifications").insert({
            type: "NEW_OPPORTUNITY",
            title: `Pursue: ${o.title}`,
            body:
              `Score ${engine.pursuitScore} · ${source.name}${o.agency ? ` · ${o.agency}` : ""}` +
              ` · due ${fmtDate(o.dueDate)}${engine.setAsides.length ? ` · ${engine.setAsides[0]}` : ""}`,
            opportunity_id: oppId,
            source_id: source.id,
            severity: "warning",
          });
        } else if (engine.bucket === "CAPTURE_REVIEW") {
          await sb.from("notifications").insert({
            type: "NEW_OPPORTUNITY",
            title: `Capture review: ${o.title}`,
            body: `Score ${engine.pursuitScore} · ${source.name}${o.agency ? ` · ${o.agency}` : ""} · due ${fmtDate(o.dueDate)}`,
            opportunity_id: oppId,
            source_id: source.id,
            severity: "info",
          });
        }
      } else if (ex.content_hash !== hash) {
        // ── AMENDED ──────────────────────────────────────────────────────────
        const closed = ["CLOSED", "REMOVED", "AWARDED", "CANCELLED"].includes(ex.status);
        const newStatus = closed ? ex.status : "AMENDED";
        await sb
          .from("opportunities")
          .update({ ...fields, status: newStatus, last_seen_at: nowISO() })
          .eq("id", ex.id);
        changedCount++;
        toScore.push({ id: ex.id, o, engine });
        const { data: vmax } = await sb
          .from("opportunity_versions")
          .select("version_no")
          .eq("opportunity_id", ex.id)
          .order("version_no", { ascending: false })
          .limit(1)
          .maybeSingle();
        await sb.from("opportunity_versions").insert({
          opportunity_id: ex.id,
          version_no: (vmax?.version_no ?? 0) + 1,
          snapshot_json: o as unknown as Record<string, unknown>,
          content_hash: hash,
          change_summary: "Amended on portal",
        });
        if (ex.status !== newStatus) {
          await sb.from("opportunity_status_log").insert({
            opportunity_id: ex.id,
            field: "status",
            old_value: ex.status,
            new_value: newStatus,
            changed_by: "system",
            reason: "Content changed on portal",
          });
        }
        await sb.from("notifications").insert({
          type: "AMENDMENT",
          title: `Amended: ${o.title}`,
          body: `${source.name} — requirements changed; a draft in progress may be based on stale requirements.`,
          opportunity_id: ex.id,
          source_id: source.id,
          severity: "warning",
        });
      } else {
        // ── UNCHANGED ── touch last_seen only (NEW→OPEN after a day). ──────────
        const patch: Record<string, unknown> = { last_seen_at: nowISO() };
        if (ex.status === "NEW") patch.status = "OPEN";
        await sb.from("opportunities").update(patch).eq("id", ex.id);
      }
    }

    // ── Reconciliation: items previously seen but absent this run ─────────────
    for (const [extId, ex] of existing) {
      if (seen.has(extId)) continue;
      if (["CLOSED", "REMOVED", "AWARDED", "CANCELLED"].includes(ex.status)) continue;
      const pastDue = ex.due_date ? new Date(ex.due_date).getTime() < Date.now() : false;
      const newStatus = pastDue ? "CLOSED" : "REMOVED";
      await sb.from("opportunities").update({ status: newStatus, closed_at: nowISO() }).eq("id", ex.id);
      await sb.from("opportunity_status_log").insert({
        opportunity_id: ex.id,
        field: "status",
        old_value: ex.status,
        new_value: newStatus,
        changed_by: "system",
        reason: pastDue ? "Past due date and no longer listed" : "No longer listed on portal",
      });
      closedCount++;
    }

    // ── Stage 2: profile-aware LLM bid/no-bid on engine survivors ──────────────
    // Excluded items never reach the LLM (that's where the §8 noise reduction cuts
    // token cost); everything else gets the AI check because thin state-portal
    // titles routinely under-score on exact-phrase matching.
    const survivors = toScore.filter(({ engine }) => !engine.excludedReason);
    if (survivors.length) {
      try {
        const company = await getCompanySettings();
        const profile = buildProfileFromTargeting(company, targeting);
        const capped = survivors.slice(0, 80); // bound per-run cost/time on serverless
        const verdicts = await classifyRelevanceLLM(
          capped.map(({ id, o }) => ({
            id,
            title: o.title,
            agency: o.agency,
            category: o.category,
            description: o.description,
            naicsCode: o.naicsCode,
          })),
          profile,
        );
        let llmScored = 0;
        let disagreements = 0;
        for (const { id, engine } of capped) {
          const v = verdicts.get(id);
          if (!v) continue;
          // Engine says pursue-worthy but LLM says NO_BID → flag for a human.
          const disagree = engine.bucket === "PURSUE" && v.recommendation === "NO_BID";
          if (disagree) disagreements++;
          // AI-analyst promotion: thin state-portal listings often lack the profile's
          // phrase vocabulary ("ShareGate", "PAM solution"), so a confident LLM BID
          // lifts the item into the shortlist — transparently, never past an exclusion.
          const promoted =
            v.recommendation === "BID" &&
            !engine.excludedReason &&
            (engine.bucket === "MANUAL_REVIEW" || engine.bucket === "IGNORE");
          const patch: Record<string, unknown> = {
            relevance_score: v.score,
            relevance_reason: disagree ? `${v.reason} · ⚠ differs from engine — needs human review` : v.reason,
            bid_recommendation: v.recommendation,
            relevance_method: "llm",
          };
          if (promoted) {
            patch.pursuit_bucket = v.score >= 90 ? "PURSUE" : "CAPTURE_REVIEW";
            patch.score_breakdown = [
              ...engine.breakdown,
              {
                criterion: "AI analyst promotion",
                points: 0,
                matched: [v.reason.slice(0, 80)],
                note: `Engine scored ${engine.pursuitScore} (thin listing text); profile-aware AI rated BID (${v.score}/100)`,
              },
            ] as unknown as Record<string, unknown>[];
          }
          await sb.from("opportunities").update(patch).eq("id", id);
          llmScored++;
        }
        if (llmScored) notes.push(`LLM verified ${llmScored} engine survivor(s)${disagreements ? `, ${disagreements} disagreement(s) flagged` : ""}`);
        if (survivors.length > capped.length)
          notes.push(`LLM verified ${capped.length}/${survivors.length}; remainder keep engine score`);
      } catch (e) {
        warnings.push(`LLM relevance check skipped: ${(e as Error).message}`);
      }
    }
    if (toScore.length) {
      notes.push(
        `Engine bucketed ${toScore.length} new/amended: ` +
          `${toScore.filter((t) => t.engine.bucket === "PURSUE").length} pursue, ` +
          `${toScore.filter((t) => t.engine.bucket === "CAPTURE_REVIEW").length} capture, ` +
          `${toScore.filter((t) => t.engine.bucket === "MANUAL_REVIEW").length} manual, ` +
          `${toScore.filter((t) => t.engine.bucket === "IGNORE").length} ignore`,
      );

      // ── Download documents for strong-fit new/amended items (PURSUE first) ────
      const byBucket = (b: string) => toScore.filter(({ engine }) => engine.bucket === b).map((x) => x.id);
      const relevantIds = [...byBucket("PURSUE"), ...byBucket("CAPTURE_REVIEW")].slice(0, 12);
      let docs = 0;
      for (const id of relevantIds) {
        try {
          const r = await fetchOpportunityDocuments(id, { max: 4 });
          docs += r.stored;
        } catch {
          /* never let a document fetch fail the crawl */
        }
      }
      if (docs) notes.push(`Downloaded ${docs} document(s) for strong-fit items`);
    }

    const durationMs = Date.now() - startedAt;
    const status = warnings.length ? "partial" : "success";
    await sb
      .from("sources")
      .update({
        last_run_at: nowISO(),
        last_success_at: nowISO(),
        status: "active",
        consecutive_failures: 0,
      })
      .eq("id", source.id);
    await sb
      .from("crawl_runs")
      .update({
        finished_at: nowISO(),
        status,
        items_found: itemsFound,
        new_count: newCount,
        changed_count: changedCount,
        closed_count: closedCount,
        error_count: 0,
        duration_ms: durationMs,
        log: [...notes, ...warnings].join("\n"),
      })
      .eq("id", runId!);

    return {
      sourceId: source.id,
      sourceName: source.name,
      runId,
      status,
      itemsFound,
      newCount,
      changedCount,
      closedCount,
      errorCount: 0,
      methodUsed,
      warnings,
      durationMs,
    };
  } catch (e) {
    const durationMs = Date.now() - startedAt;
    const message = (e as Error).message;
    if (runId) {
      await sb
        .from("crawl_runs")
        .update({ finished_at: nowISO(), status: "failed", error_count: 1, duration_ms: durationMs, log: message })
        .eq("id", runId);
    }
    await sb
      .from("sources")
      .update({
        last_run_at: nowISO(),
        status: "error",
        consecutive_failures: (source.consecutive_failures ?? 0) + 1,
      })
      .eq("id", source.id);
    await sb.from("notifications").insert({
      type: "CRAWL_FAILURE",
      title: `Crawl failed: ${source.name}`,
      body: message,
      source_id: source.id,
      severity: "critical",
    });
    return {
      sourceId: source.id,
      sourceName: source.name,
      runId,
      status: "failed",
      itemsFound,
      newCount,
      changedCount,
      closedCount,
      errorCount: 1,
      methodUsed,
      warnings,
      durationMs,
      error: message,
    };
  }
}
