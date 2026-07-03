# AJACE Targeted Opportunity Engine — Complete Build Plan

**Goal:** replace broad "IT Services"-style matching with a five-dimension, weighted targeting
engine so the platform surfaces only opportunities appropriate for Team AJACE, with a due date
at least 10 calendar days out.

**The five dimensions (requirement §0):**
1. **Opportunity Type** — solicitation type (RFP/RFQ/RFI/Sources Sought) + functional areas
2. **Technical Capability** — capability phrase groups, labor categories, technologies
3. **Contracting Vehicle** — GSA MAS, BPA, Task Order, etc.
4. **Socioeconomic Preference** — 8(a), WOSB, set-asides (AJACE is SBA-certified 8(a), WOSB, MBE)
5. **Exclude Keywords** — construction/medical/vehicles/supplies/architecture noise

**How phrases are used — two modes (important):**
- **Query mode** (API-driven sources, e.g. SAM.gov): Primary Search Phrases become the actual
  search queries sent to the source's API.
- **Score mode** (scrape-all portals we already crawl): we pull everything and the phrases become
  weighted matchers in the scoring engine.
Both modes share one config — the **Targeting Profile** — so Susan edits keywords once.

---

## 1. Requirements traceability matrix

| Req | Requirement | Where in this plan |
|-----|-------------|--------------------|
| §0 | Five search dimensions | Profile schema (§3), engine (§4) |
| §0 | Due date ≥ 10 days out | Date filter (§4.9) |
| §1 | Primary Search Phrases — 10 capability groups | Profile `capabilities` (§3.1) |
| §2 | Government Functional Areas (10 phrases) | Profile `functionalAreas` (§3.2) |
| §3 | Labor Categories (21 titles) | Profile `laborCategories` (§3.3) |
| §4 | Technologies (Microsoft/Cloud/Development/Database) | Profile `technologies` (§3.4) |
| §5 | Contract Vehicle Keywords (9) | Profile `vehicles` (§3.5) |
| §6 | Small Business Filters (3 priority tiers) | Profile `setAsides` (§3.6) |
| §7 | Priority Agencies (21 federal + 13 states, DoD IT-only) | Profile `agencies` (§3.7) |
| §8 | Exclude Keywords (5 groups, 27 terms) | Profile `exclusions` (§3.8), logic §4.5 |
| §9 | Scoring table (16 criteria) + thresholds (80/60/40) | Engine scoring (§4.2–4.3) |
| §10 | Date filter ≥10 days + urgency bands (10–20/21–45/46+) | §4.9 |
| Rec. | Weighted relevance engine: solicitation type, NAICS (541511/541512/541513/541519/518210), set-aside, agency priority, capabilities, estimated value, due date | Engine design §4, NAICS §4.7, value §4.8 |
| Impl. | Federal + state coverage | Source expansion §7 |
| Impl. | Susan edits keywords without code | Admin Targeting editor §6.5 |

---

## 2. Data model changes (Postgres migration)

```sql
-- New enums
create type pursuit_bucket as enum ('PURSUE','CAPTURE_REVIEW','MANUAL_REVIEW','IGNORE');
create type urgency_band  as enum ('URGENT','STANDARD','EARLY_CAPTURE','INSUFFICIENT_TIME','NO_DATE');

-- Opportunity scoring columns
alter table opportunities
  add column pursuit_score    int,                -- weighted points (raw, uncapped)
  add column pursuit_bucket   pursuit_bucket,     -- from thresholds
  add column urgency          urgency_band,       -- from due-date bands
  add column set_asides       text[] default '{}',-- detected: 8(a), WOSB, EDWOSB, HUBZone, SDVOSB, MBE, SB, Sole Source, Direct Award
  add column contract_vehicle text,               -- detected: GSA MAS / BPA / Task Order / ...
  add column solicitation_type text,              -- RFP / RFQ / RFI / Sources Sought / ITB
  add column agency_priority  boolean default false,
  add column excluded_reason  text,               -- which exclude keyword fired (null = not excluded)
  add column score_breakdown  jsonb;              -- [{criterion, points, matched: [phrases]}, ...]
create index idx_opp_bucket on opportunities(pursuit_bucket);
create index idx_opp_pursuit on opportunities(pursuit_score desc nulls last);
```

`urgency` is recomputed daily (a bid drifts URGENT as its deadline approaches) by the existing
cron after crawls; views also compute it live from `due_date` so the UI is never stale.

---

## 3. The Targeting Profile (seed config — complete, verbatim)

Stored as `app_settings.key = 'targeting'` (JSONB). Editable in **Admin → Targeting** (§6.5).
Every list below ships as the seed. Nothing is hardcoded in the engine.

### 3.1 Dimension 2a — Capability phrase groups (§1 Primary Search Phrases)

| Group (scoring criterion) | Points | Phrases |
|---|---|---|
| **Program & Project Management** (crit: "Program Management", 9) | 9 | Program Management · Project Management · PMO Support · Program Office Support · Project Management Office · Technical Program Management · IT Program Management · Program Support Services · Management Support Services · Enterprise Program Management |
| **Acquisition & Contract Support** (crit: "Acquisition Support", 7) | 7 | Acquisition Support · Contract Support · Procurement Support · Contract Administration · Acquisition Management · Federal Acquisition Support · Procurement Operations · Source Selection Support · Contract Closeout · Acquisition Lifecycle |
| **Digital Transformation / IT Modernization** (crit: "IT Modernization", 10) | 10 | Digital Transformation · Business Process Modernization · IT Modernization · Legacy System Modernization · Modernization Services · Enterprise Modernization |
| **Software Development** (crit: "Application Development", 10) | 10 | Application Development · Software Development · Agile Development · Full Stack Development · DevSecOps · Systems Integration · API Integration · Custom Software Development · Enterprise Application Support · Low Code · Microsoft Power Platform · PowerApps · Power Automate |
| **Data** (crit: "Data Analytics", 9) | 9 | Data Analytics · Data Management · Business Intelligence · Dashboard Development · Data Warehouse · Data Governance · Data Integration · ETL · SQL · Reporting Services · Power BI · Tableau |
| **AI** (crit: "AI", 9) | 9 | Artificial Intelligence · AI · Machine Learning · Generative AI · Intelligent Automation · Robotic Process Automation · RPA · AI Enablement · AI Integration · AI Services |
| **Cloud** (crit: "Cloud", 8) | 8 | Cloud Migration · Cloud Engineering · Azure · AWS · Cloud Modernization · Cloud Operations · Cloud Support · Hybrid Cloud |
| **Cybersecurity** (crit: "Cybersecurity", 8) | 8 | Cybersecurity · Information Security · Security Operations · SOC · Vulnerability Management · Zero Trust · Risk Management Framework · Continuous Monitoring · Security Assessment |
| **Infrastructure** (default 6*) | 6* | Infrastructure Support · Enterprise IT · Systems Administration · Network Support · IT Operations · Enterprise Operations |
| **Service Desk** (crit: "Service Desk", 7) | 7 | Service Desk · Help Desk · IT Support · End User Support · Customer Support · Tier 1 · Tier 2 · Tier 3 |
| **Business Analysis** (crit: "Business Analysis", 7) | 7 | Business Analysis (+ labor categories Business Analyst / Functional Analyst count toward this criterion) |

\* The §9 scoring table does not assign Infrastructure a value; **default 6, configurable** —
documented assumption, adjustable in the Admin editor.

**"AI" special-case matching:** matched only as a whole word / with word boundaries
(`\bAI\b`), never inside words (avoids "mAIntenance", "retAIl").
"Tier 1/2/3" matched only when co-occurring with support/desk context within the same sentence.

### 3.2 Dimension 1b — Government Functional Areas (§2) — default 4 pts*, configurable

Administrative Support · Program Support · Business Operations · Technical Assistance ·
Technical Support · Operational Support · Enterprise Support · Mission Support ·
Management Consulting · Organizational Change Management

\* Not in the §9 table; they are supporting signals ("many agencies don't describe opportunities
by technology"), so they score modestly and count toward surfacing, never toward exclusion.

### 3.3 Dimension 2b — Labor Categories (§3) — feed their parent capability criterion

| Labor category | Counts toward |
|---|---|
| Program Manager, Project Manager | Program & Project Management |
| Business Analyst, Functional Analyst | Business Analysis |
| Technical Writer | Program & Project Management (support role) |
| Solutions Architect, Enterprise Architect | Software Development |
| Database Administrator | Data |
| Data Analyst, Data Engineer | Data |
| Software Engineer, Software Developer, Full Stack Developer | Software Development |
| Cloud Engineer | Cloud |
| DevSecOps Engineer | Software Development |
| Cybersecurity Analyst | Cybersecurity |
| Help Desk Specialist | Service Desk |
| Systems Administrator, Network Engineer | Infrastructure |
| QA Analyst, Test Engineer | Software Development |

A labor-category match awards its parent criterion's points (once per criterion), so a staffing-style
solicitation that only says "seeking two Full Stack Developers and a QA Analyst" still scores as
Application Development.

### 3.4 Dimension 2c — Technologies (§4) — feed their parent capability criterion

| Tech group | Terms | Counts toward |
|---|---|---|
| Microsoft | .NET · C# · SQL Server · SharePoint · Microsoft Azure · Power BI · Power Platform · Dynamics 365 | Software Development (Power BI → Data) |
| Cloud | AWS · Azure · Kubernetes · Docker · Terraform | Cloud |
| Development | Java · Python · JavaScript · React · Angular · Node.js · REST API | Software Development |
| Database | Oracle · PostgreSQL · SQL Server · MySQL | Data |

(`SQL Server` appears in two source lists — deduped; `C#`, `.NET`, `Node.js` matched with
symbol-aware boundaries.)

### 3.5 Dimension 3 — Contract Vehicle Keywords (§5)

GSA MAS · Multiple Award Schedule · BPA · Blanket Purchase Agreement · Task Order · RFQ · RFP ·
RFI · Sources Sought

- **GSA MAS / Multiple Award Schedule = 6 pts** (per §9 table). Other vehicles (BPA, Blanket
  Purchase Agreement, Task Order): default 4*, configurable.
- RFQ/RFP/RFI/Sources Sought are captured as `solicitation_type` metadata (Recommendation item 1)
  rather than scored — they identify the opportunity type; configurable per-type points
  (default: RFP/RFQ 2, RFI/Sources Sought 1 — early-capture signals).

### 3.6 Dimension 4 — Small Business / Socioeconomic Filters (§6)

| Tier | Terms | Points |
|---|---|---|
| **Highest** | 8(a) · Sole Source · Direct Award · Woman-Owned Small Business · WOSB · EDWOSB · Small Business Set Aside | 8(a) Set-Aside = **10** (§9) · WOSB/EDWOSB/Woman-Owned = **10** (§9) · Small Business Set-Aside = **8** (§9) · Sole Source / Direct Award = **10*** (listed "Highest Priority"; §9 table has no row — default 10, configurable) |
| **Secondary** | HUBZone · SDVOSB · MBE | default **6***, configurable |
| **General** | Small Business · Socioeconomic Set Aside | counts as Small Business Set-Aside (8) when phrased as a set-aside; otherwise +2 general signal |
| Detected values also stored in `opportunities.set_asides[]` for filtering/UI badges. | | |

### 3.7 Metadata — Priority Agencies (§7) — "Federal Agency = 6, State Government = 5" (§9)

**Federal (6 pts when the issuing agency matches):**
GSA · Department of Transportation · FAA · FMCSA · HUD · HHS · CMS · NIH · CDC · DHS · CBP ·
USCIS · DOJ · Treasury · IRS · USDA · VA · **DoD (IT only)** · DOE · NHTSA · FDIC

- **DoD IT-only rule:** DoD earns agency points **only if** at least one Technical Capability
  criterion (§3.1) also matched; otherwise DoD contributes 0.
- Matching includes common aliases (e.g. "Internal Revenue Service" → IRS, "Veterans Affairs" → VA);
  the alias map lives in the profile and is editable.

**State (5 pts when the source/agency state matches):**
Virginia · Maryland · Pennsylvania · New York · New Jersey · North Carolina · South Carolina ·
Georgia · Florida · Texas · Ohio · Minnesota · Mississippi

### 3.8 Dimension 5 — Exclude Keywords (§8)

| Group | Terms |
|---|---|
| Construction | Construction · Roofing · HVAC · Plumbing · Electrical · Janitorial · Landscaping · Snow Removal · Concrete · Paving |
| Medical | Pharmaceuticals · Medical Equipment · Nursing · Physician · Hospital Equipment |
| Vehicles | Vehicle Purchase · Fleet Vehicles · Buses · Heavy Equipment |
| Supplies | Office Supplies · Furniture · Uniforms · Food Service · Fuel |
| Architecture | Architectural Design · Civil Engineering · Surveying |

Exclusion logic in §4.5 (with the IT-signal override guard so "IT Modernization for the fleet
management system" isn't wrongly killed by the word "Fleet").

### 3.9 NAICS alignment (Recommendation)

`541511, 541512, 541513, 541519, 518210` — a NAICS match adds the **Federal/State-independent
capability confirmation**: +6 (configurable) and is displayed as a matched criterion. (Merges the
existing `relevance.naics` setting into the profile.)

### 3.10 Estimated contract value (Recommendation)

Configurable band scoring, applied **only when the portal exposes a value** (most state listings
don't — best-effort by design): default `< $25k: −2 · $25k–$100k: 0 · $100k–$1M: +2 · $1M–$10M: +3 · > $10M: +1`
(sweet-spot curve, editable). Never a hard filter.

---

## 4. The Weighted Relevance Engine (`src/lib/targeting/engine.ts`)

Pure, deterministic, fast function — runs on every crawled/uploaded item at zero LLM cost:

```ts
scoreOpportunity(opp: {title, description, category, agency, naics, docText?, dueDate,
                       estimatedValue, sourceState, solicitationTypeHint}, profile: TargetingProfile)
  → { pursuitScore, bucket, urgency, breakdown[], setAsides[], vehicle,
      solicitationType, agencyPriority, excludedReason }
```

### 4.1 Matching rules
- Case-insensitive, **word-boundary** phrase matching (regex-escaped, `\b`-anchored; special
  handling for `C#`, `.NET`, `8(a)`, `Node.js`).
- Fields searched: `title` (weight ×1.0) + `description` + `category` + **parsed document text**
  when available (the platform already extracts RFP PDF text — the engine reads real requirements,
  not just the listing blurb).
- **A criterion scores once** no matter how many of its phrases match (per §9: score per criterion,
  not per keyword). All matched phrases are recorded in `score_breakdown` for the UI.

### 4.2 Scoring table (§9 — implemented verbatim)

| Criterion | Points | Source |
|---|---|---|
| IT Modernization | 10 | §9 |
| Application Development | 10 | §9 |
| Program Management | 9 | §9 |
| Data Analytics | 9 | §9 |
| AI | 9 | §9 |
| Cloud | 8 | §9 |
| Cybersecurity | 8 | §9 |
| Service Desk | 7 | §9 |
| Business Analysis | 7 | §9 |
| Acquisition Support | 7 | §9 |
| GSA MAS | 6 | §9 |
| Federal Agency | 6 | §9 |
| State Government | 5 | §9 |
| 8(a) Set-Aside | 10 | §9 |
| WOSB Set-Aside | 10 | §9 |
| Small Business Set-Aside | 8 | §9 |
| *(defaults, configurable)* Infrastructure 6 · Functional Areas 4 · Sole Source/Direct Award 10 · HUBZone/SDVOSB/MBE 6 · other vehicles 4 · NAICS 6 · solicitation type 1–2 · value band −2…+3 | | documented assumptions |

### 4.3 Thresholds → buckets (§9, verbatim)

| Score | Bucket | Platform behavior |
|---|---|---|
| **80+** | `PURSUE` ("Pursue immediately") | Top of default views · PURSUE notification · auto-document-pull · eligible for auto-draft |
| **60–79** | `CAPTURE_REVIEW` ("Capture review") | Default views · document pull |
| **40–59** | `MANUAL_REVIEW` ("Manual review") | Visible under "Manual review" filter |
| **< 40** | `IGNORE` | Hidden by default (still stored & auditable) |

### 4.4 Five-dimension composition
Dimension 1 (type) → `solicitation_type` + functional-area points ·
Dimension 2 (capability) → capability/labor/tech criteria ·
Dimension 3 (vehicle) → vehicle points + metadata ·
Dimension 4 (socioeconomic) → set-aside points + `set_asides[]` ·
Dimension 5 (exclusions) → §4.5.

### 4.5 Exclusion logic (Dimension 5)
1. If any exclude keyword matches **and** zero Technical Capability criteria match →
   `bucket = IGNORE`, `excluded_reason = "<keyword> (<group>)"`, score still computed for audit.
2. If an exclude keyword matches **but** ≥1 capability criterion also matched (≥7 pts) → **not**
   excluded; the exclusion hit is noted in the breakdown ("Electrical matched but overridden by
   IT Modernization") so reviewers see why.
3. Excluded items never reach the LLM stage → the noise elimination also cuts LLM cost.

### 4.6 Hybrid LLM stage (keeps what works today)
The existing LLM bid/no-bid classifier is **kept** as stage 2, now profile-aware:
- Runs only on items scoring ≥ 40 (Manual review and above) that weren't excluded — the
  deterministic engine handles the thousands of obvious no-bids for free.
- Its prompt now includes the five-dimension profile (capabilities, set-aside certifications
  8(a)/WOSB/MBE, priority agencies, exclusions) instead of the current flat keyword list.
- Disagreements (engine says PURSUE, LLM says NO_BID or vice versa) are flagged
  `needs human review` in the breakdown panel — the two signals are complementary, not overriding.

### 4.7 NAICS (Recommendation) — §3.9. 
### 4.8 Estimated value (Recommendation) — §3.10.

### 4.9 Date filter & urgency bands (§10 — verbatim)

- **Hard rule:** default pursue/capture views and PURSUE notifications include only
  `due_date ≥ today + 10 calendar days`. Items with less time are stored and visible under an
  "Insufficient time" filter (never silently dropped), marked `INSUFFICIENT_TIME`.
- **Urgency flags:** `10–20 days → URGENT` · `21–45 days → STANDARD` (standard pursuit) ·
  `46+ days → EARLY_CAPTURE` (early capture opportunity) · no due date → `NO_DATE`
  (kept visible, flagged for manual date confirmation).
- Recomputed daily by cron (bands drift as deadlines approach) + computed live in views.
- Query-mode sources (SAM.gov) additionally pass `responseDeadline ≥ today+10` **into the API
  query** so out-of-time items are never even fetched.

---

## 5. Pipeline integration

1. **Crawl pipeline** (`src/lib/crawl/pipeline.ts`): after normalize/dedupe, run
   `scoreOpportunity()` on every NEW/AMENDED item (replaces the current keyword scorer);
   persist all §2 columns; then the profile-aware LLM stage per §4.6. Amended items rescore
   (a scope change can change the bucket — the team is notified when a tracked item drops out
   or jumps into PURSUE).
2. **Backfill:** extend `/api/relevance/rescore` → `/api/targeting/rescore` to re-score all
   existing ~2,400 stored opportunities in bounded batches (same loop-until-done pattern as the
   document backfill).
3. **My Bids:** uploaded bids get the same engine run on save (their uploaded document text
   included), so Susan's pipeline shows the same score/bucket/urgency chips.
4. **Notifications:** new `PURSUE` notification (score ≥ 80, due ≥ 10 days, not excluded);
   existing amendment/deadline alerts unchanged.
5. **Dedupe/change-detection:** unchanged — scoring happens after the existing §4 pipeline decides
   NEW/AMENDED/unchanged, so unchanged items are still never re-processed.

## 6. UI changes

1. **Opportunities list:** default view = `PURSUE + CAPTURE_REVIEW`, due ≥ 10 days (replaces the
   current "Strong fit only" switch with a bucket filter: Pursue / Capture review / Manual review /
   Ignored / Insufficient time). New columns: **Score** (points + bucket chip), **Urgency** chip
   (Urgent / Standard / Early capture), set-aside badges (8(a), WOSB…), vehicle badge.
2. **Opportunity detail:** "Why this score" panel — the full `score_breakdown` (each criterion,
   points, exact phrases that matched, exclusion hits/overrides, LLM verdict agreement flag).
3. **Dashboard:** bucket tiles (Pursue now / Capture review / closing within 10 days), urgency
   distribution, and "new PURSUE since yesterday".
4. **Pipeline board:** bucket + urgency chips on cards.
5. **Admin → Targeting (new tab):** full profile editor — every list from §3 editable (add/remove
   phrases, change points, edit thresholds 80/60/40, urgency bands, exclusions, agency lists,
   NAICS, value bands), with a "test a title/description against the profile" sandbox and a
   one-click "re-score everything" button. **This is how Susan tunes targeting without code.**
6. **Analytics:** score histogram, bucket counts by source, exclusion counts by group (proves the
   noise reduction), win-rate by bucket over time.

## 7. Source expansion (the "State and federal opportunity sites" requirement)

**Federal — SAM.gov (new, Phase 4):** official *Get Opportunities* public API
(`api.sam.gov/opportunities/v2/search`, free API key via env var). Query mode: Primary Search
Phrases + NAICS list + set-aside codes (8(a) = `8A`, WOSB, SB) + `responseDeadline ≥ today+10`;
federal agency list applied as a priority boost, DoD results kept only with IT capability match
(§3.7 rule). Full engine re-scores everything fetched (belt-and-braces).

**Priority states (§7 list, phased):** already live — **Pennsylvania, North Carolina** (+ TN, AR,
MA). To add, in order: **Virginia (eVA) → Maryland (eMMA) → Texas (ESBD) → Georgia → Florida →
New York → New Jersey → Ohio → South Carolina → Minnesota → Mississippi** — one connector each via
the existing tiered adapter framework (JSON API → static HTML → ViewState/Playwright), reusing the
recon-agent workflow that mapped the first five portals.

## 8. APIs

- `GET/PUT /api/targeting` — read/update the profile (admin-gated; writes are versioned into a
  `targeting_profile_versions` audit table so keyword changes are traceable).
- `POST /api/targeting/rescore` — batch re-score (loopable, `{batch, remaining, done}`).
- `POST /api/targeting/test` — score an ad-hoc `{title, description}` against the current profile
  (powers the Admin sandbox).
- Opportunities list API: new filters `bucket`, `urgency`, `setAside`, `vehicle`, `minDays`.

## 9. Testing & verification

1. **Golden-set unit tests** for the engine: ~40 fixture solicitations with expected
   bucket/score — includes every tricky case: `\bAI\b` boundaries, `C#`/`.NET`/`8(a)` symbols,
   DoD-without-IT (no agency points), exclusion override ("IT Modernization of HVAC monitoring"),
   Sole Source boost, 10-day boundary (day 9 = INSUFFICIENT, day 10 = URGENT), 20/21 and 45/46
   band edges, labor-category-only solicitation, technology-only solicitation, functional-area-only.
2. **Re-score the live 2,400-opportunity corpus** and manually spot-check: top-20 PURSUE items are
   genuinely AJACE-appropriate; sample of IGNOREs contains no false negatives; compare bucket
   distribution vs. the current LLM verdicts (expect strong agreement on BID↔PURSUE).
3. **Live end-to-end:** crawl → score → buckets/urgency in UI → breakdown panel → Admin edits a
   weight → re-score shifts buckets → PURSUE notification fires. Deploy, then multi-agent
   verification sweep (same pattern used for prior releases).

## 10. Phased delivery

| Phase | Scope | Est. |
|---|---|---|
| **1. Engine + data** | Migration (§2), profile seed (§3 — every list verbatim), engine (§4) with exclusions/set-asides/vehicles/agencies/NAICS/value/date-bands, pipeline integration + rescore backfill (§5), golden-set tests | 1 session |
| **2. UI** | List default views/filters/chips, detail breakdown panel, dashboard tiles, board chips (§6.1–6.4) | 1 session |
| **3. Admin editor + hybrid LLM** | Targeting editor + sandbox + versioning (§6.5), profile-aware LLM prompt + disagreement flag (§4.6), PURSUE notifications | 1 session |
| **4. Federal + states** | SAM.gov connector (query mode), then priority-state connectors in §7 order (~½–1 session per portal; VA/MD/TX first) | rolling |
| **5. Verify + docs** | §9.2–9.3, README/analytics updates | ½ session |

## 11. Risks & documented assumptions

- **§9 table gaps** — Infrastructure, functional areas, Sole Source/Direct Award, HUBZone/SDVOSB/MBE,
  non-GSA vehicles, solicitation types, NAICS and value weights are not in the requirement's table;
  all defaults above are **flagged as configurable assumptions** surfaced in the Admin editor for
  Susan to tune (this plan invents no hidden behavior).
- **State portals rarely expose** set-aside, NAICS, or value fields — the engine reads them from
  parsed document text when the listing lacks them; scores degrade gracefully when absent.
- **Word-boundary matching** can still misfire on genuinely ambiguous terms ("Electrical
  Engineering Services for data center") — the exclusion-override guard plus breakdown transparency
  keeps every decision reviewable, and MANUAL_REVIEW exists precisely for the gray zone.
- **SAM.gov API quotas** (personal keys are rate-limited) — nightly pull sized to quota; upgradeable.
- **Threshold drift** — after the first live week, compare buckets against Susan's actual
  pursue/pass decisions and tune points/thresholds in Admin (no code changes needed).
