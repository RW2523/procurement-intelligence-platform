import type {
  PursuitBucket,
  ScoreBreakdownEntry,
  TargetingProfile,
  UrgencyBand,
} from "@/lib/types";

/**
 * The deterministic weighted relevance engine (docs/TARGETING-ENGINE-PLAN.md §4).
 * Pure function — no I/O, no LLM tokens — so it can score thousands of items per
 * crawl for free. The profile-aware LLM check runs as a second stage on survivors.
 */

export interface EngineInput {
  title: string;
  description?: string | null;
  category?: string | null;
  agency?: string | null;
  naicsCode?: string | null;
  /** Parsed solicitation-document text when available (reads real requirements). */
  docText?: string | null;
  dueDate?: string | Date | null;
  estimatedValue?: number | null;
  /** Two-letter state of the issuing portal (e.g. "PA"), when known. */
  sourceState?: string | null;
  /** True when the source itself is federal (e.g. SAM.gov). */
  federalSource?: boolean;
}

export interface EngineResult {
  pursuitScore: number;
  bucket: PursuitBucket;
  urgency: UrgencyBand;
  breakdown: ScoreBreakdownEntry[];
  setAsides: string[];
  contractVehicle: string | null;
  solicitationType: string | null;
  agencyPriority: boolean;
  excludedReason: string | null;
}

/** State-name → USPS code for matching the profile's priority-state list. */
const STATE_CODES: Record<string, string> = {
  Virginia: "VA", Maryland: "MD", Pennsylvania: "PA", "New York": "NY", "New Jersey": "NJ",
  "North Carolina": "NC", "South Carolina": "SC", Georgia: "GA", Florida: "FL", Texas: "TX",
  Ohio: "OH", Minnesota: "MN", Mississippi: "MS",
};

/**
 * Build a word-boundary regex for a phrase. Handles symbol-heavy terms the default
 * \b would break on: "C#", ".NET", "8(a)", "Node.js". Short all-caps terms (AI, SOC,
 * RPA, ETL...) are matched case-SENSITIVELY as whole words so "AI" never fires inside
 * "maintenance" / "retail" and "SOC" not inside "associates".
 */
export function phraseRegex(phrase: string): { re: RegExp; caseSensitive: boolean } {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const startsWord = /^[A-Za-z0-9]/.test(phrase);
  const endsWord = /[A-Za-z0-9)]$/.test(phrase) && !phrase.endsWith(")");
  const lead = startsWord ? "(?<![A-Za-z0-9])" : "";
  const tail = endsWord ? "(?![A-Za-z0-9])" : "";
  const caseSensitive = phrase.length <= 4 && phrase === phrase.toUpperCase() && /^[A-Z0-9().#]+$/.test(phrase);
  return { re: new RegExp(`${lead}${escaped}${tail}`, caseSensitive ? "" : "i"), caseSensitive };
}

function matchPhrase(phrase: string, text: string): boolean {
  try {
    return phraseRegex(phrase).re.test(text);
  } catch {
    return text.toLowerCase().includes(phrase.toLowerCase());
  }
}

/** "Tier 1/2/3" only count near support-desk context (avoids pricing-tier noise). */
const TIER_CONTEXT = /(help ?desk|service desk|support|call center|ticket)/i;

function capabilityPhraseMatches(phrase: string, text: string): boolean {
  if (/^Tier [123]$/i.test(phrase)) {
    return matchPhrase(phrase, text) && TIER_CONTEXT.test(text);
  }
  return matchPhrase(phrase, text);
}

/** §10 urgency bands from calendar days remaining. */
export function urgencyFor(dueDate: string | Date | null | undefined, bands: TargetingProfile["dateBands"]): UrgencyBand {
  if (!dueDate) return "NO_DATE";
  const due = typeof dueDate === "string" ? new Date(dueDate) : dueDate;
  if (Number.isNaN(due.getTime())) return "NO_DATE";
  const today = new Date();
  const days = Math.floor(
    (Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate()) -
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) / 86_400_000,
  );
  if (days < bands.minDays) return "INSUFFICIENT_TIME";
  if (days <= bands.urgentMax) return "URGENT";
  if (days <= bands.standardMax) return "STANDARD";
  return "EARLY_CAPTURE";
}

export function scoreOpportunity(input: EngineInput, profile: TargetingProfile): EngineResult {
  // Title is weighted implicitly by being present; docText brings the real RFP scope.
  const text = [input.title, input.description, input.category, (input.docText ?? "").slice(0, 30_000)]
    .filter(Boolean)
    .join("\n");
  // Agency matching deliberately skips the description: "GSA MAS" in a scope blurb
  // is vehicle evidence, not proof GSA is the issuing agency.
  const agencyText = [input.agency, input.title].filter(Boolean).join("\n");

  const breakdown: ScoreBreakdownEntry[] = [];
  let score = 0;

  // ── Dimension 2: capabilities (groups score once; labor cats & tech feed groups) ──
  const groupMatches = new Map<string, string[]>();
  for (const g of profile.capabilities) {
    const hits = g.phrases.filter((p) => capabilityPhraseMatches(p, text));
    if (hits.length) groupMatches.set(g.key, hits);
  }
  for (const lc of profile.laborCategories) {
    if (matchPhrase(lc.title, text)) {
      const arr = groupMatches.get(lc.group) ?? [];
      if (!groupMatches.has(lc.group)) groupMatches.set(lc.group, arr);
      arr.push(`${lc.title} (labor category)`);
    }
  }
  for (const t of profile.technologies) {
    if (matchPhrase(t.term, text)) {
      const arr = groupMatches.get(t.group) ?? [];
      if (!groupMatches.has(t.group)) groupMatches.set(t.group, arr);
      arr.push(`${t.term} (technology)`);
    }
  }
  let capabilityPoints = 0;
  for (const g of profile.capabilities) {
    const hits = groupMatches.get(g.key);
    if (!hits?.length) continue;
    score += g.points;
    capabilityPoints += g.points;
    breakdown.push({ criterion: g.label, points: g.points, matched: [...new Set(hits)].slice(0, 8) });
  }

  // ── Dimension 1b: functional areas ──
  const faHits = profile.functionalAreas.phrases.filter((p) => matchPhrase(p, text));
  if (faHits.length) {
    score += profile.functionalAreas.points;
    breakdown.push({ criterion: "Functional area", points: profile.functionalAreas.points, matched: faHits.slice(0, 6) });
  }

  // ── Dimension 3: vehicles + solicitation type ──
  let contractVehicle: string | null = null;
  const gsaHit = profile.vehicles.gsaTerms.find((t) => matchPhrase(t, text));
  if (gsaHit) {
    contractVehicle = "GSA MAS";
    score += profile.vehicles.gsaMasPoints;
    breakdown.push({ criterion: "GSA MAS", points: profile.vehicles.gsaMasPoints, matched: [gsaHit] });
  } else {
    const otherHit = profile.vehicles.otherTerms.find((t) => matchPhrase(t, text));
    if (otherHit) {
      contractVehicle = otherHit;
      score += profile.vehicles.otherPoints;
      breakdown.push({ criterion: "Contract vehicle", points: profile.vehicles.otherPoints, matched: [otherHit] });
    }
  }
  let solicitationType: string | null = null;
  for (const st of profile.solicitationTypes) {
    if (matchPhrase(st.term, `${input.title}\n${input.category ?? ""}\n${(input.description ?? "").slice(0, 400)}`)) {
      solicitationType = st.term;
      if (st.points) {
        score += st.points;
        breakdown.push({ criterion: `Solicitation type: ${st.term}`, points: st.points, matched: [st.term] });
      }
      break;
    }
  }

  // ── Dimension 4: set-asides (tiered; each tier scores once) ──
  const setAsides: string[] = [];
  for (const tier of profile.setAsides) {
    const hit = tier.terms.find((t) => matchPhrase(t, text));
    if (!hit) continue;
    // "Small Business (general)" shouldn't double-fire when a specific set-aside matched.
    if (tier.label.startsWith("Small Business (general)") && setAsides.length) continue;
    setAsides.push(tier.label);
    score += tier.points;
    breakdown.push({ criterion: tier.label, points: tier.points, matched: [hit] });
  }

  // ── Metadata: agency priority (DoD IT-only rule) ──
  let agencyPriority = false;
  for (const fed of profile.agencies.federal) {
    const names = [fed.name, ...fed.aliases];
    const hit = names.find((n) => matchPhrase(n, agencyText));
    if (!hit) continue;
    if (fed.itOnly && capabilityPoints === 0) {
      breakdown.push({ criterion: `Agency: ${fed.name}`, points: 0, matched: [hit], note: "DoD counts only with an IT capability match — no capability matched" });
      continue;
    }
    agencyPriority = true;
    score += profile.agencies.federalPoints;
    breakdown.push({ criterion: `Federal agency: ${fed.name}`, points: profile.agencies.federalPoints, matched: [hit] });
    break;
  }
  if (!agencyPriority) {
    const stateHit = profile.agencies.states.find(
      (s) => input.sourceState === STATE_CODES[s] || matchPhrase(s, agencyText),
    );
    if (stateHit) {
      agencyPriority = true;
      score += profile.agencies.statePoints;
      breakdown.push({ criterion: `State government: ${stateHit}`, points: profile.agencies.statePoints, matched: [stateHit] });
    }
  }

  // ── Recommendation: NAICS ──
  if (input.naicsCode && profile.naics.codes.some((c) => input.naicsCode!.startsWith(c))) {
    score += profile.naics.points;
    breakdown.push({ criterion: "NAICS alignment", points: profile.naics.points, matched: [input.naicsCode] });
  }

  // ── Recommendation: estimated value (only when known) ──
  if (input.estimatedValue != null && input.estimatedValue > 0) {
    const band =
      profile.valueBands.find((b) => b.maxUsd != null && input.estimatedValue! < b.maxUsd) ??
      profile.valueBands[profile.valueBands.length - 1];
    if (band && band.points !== 0) {
      score += band.points;
      breakdown.push({ criterion: `Estimated value ${band.label}`, points: band.points, matched: [`$${input.estimatedValue.toLocaleString()}`] });
    }
  }

  // ── Dimension 5: exclusions (with capability override guard) ──
  let excludedReason: string | null = null;
  for (const ex of profile.exclusions) {
    const hit = ex.terms.find((t) => matchPhrase(t, text));
    if (!hit) continue;
    if (capabilityPoints >= 7) {
      breakdown.push({ criterion: `Exclusion overridden (${ex.group})`, points: 0, matched: [hit], note: "Exclude keyword matched but a technical capability also matched — kept" });
      continue;
    }
    excludedReason = `${hit} (${ex.group})`;
    breakdown.push({ criterion: `Excluded: ${ex.group}`, points: 0, matched: [hit], note: "No technical capability matched — bucketed IGNORE" });
    break;
  }

  // ── §10 urgency + §9 buckets ──
  const urgency = urgencyFor(input.dueDate ?? null, profile.dateBands);
  let bucket: PursuitBucket;
  if (excludedReason) bucket = "IGNORE";
  else if (score >= profile.thresholds.pursue) bucket = "PURSUE";
  else if (score >= profile.thresholds.captureReview) bucket = "CAPTURE_REVIEW";
  else if (score >= profile.thresholds.manualReview) bucket = "MANUAL_REVIEW";
  else bucket = "IGNORE";

  return {
    pursuitScore: score,
    bucket,
    urgency,
    breakdown,
    setAsides,
    contractVehicle,
    solicitationType,
    agencyPriority,
    excludedReason,
  };
}
