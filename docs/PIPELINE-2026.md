# Pipeline_2026 — stages, field mapping, department matcher, importer

The team's real working file is `Pipeline_2026.xlsx`: 71 live opportunities on a
sheet called **Pipeline** and 4 rows on a sheet called **Forecased
Opportunities** [sic]. This document is what turns that workbook into rows in
the database.

Three things live here:

1. [The 11 capture stages](#1-the-11-capture-stages)
2. [The field mapping](#2-the-field-mapping-17-sheet-columns--the-schema)
3. [The department matcher](#3-the-department-matcher) and
   [how to run the importer](#4-running-the-importer)

---

## 1. The 11 capture stages

`pipeline_stage` is **our** axis: where the team is on a pursuit. In this order
— the order is the product decision, and the board columns, the `<select>`
options and the analytics bars all read it from `PIPELINE_STAGES` in
`src/lib/types.ts`.

| # | Code | Label | Meaning |
|---|------|-------|---------|
| 1 | `IDENTIFIED` | Identified | Seen and logged. The column default. |
| 2 | `QUALIFYING` | Qualifying | Deciding whether it fits. |
| 3 | `PURSUING` | Pursuing | Capture work underway. |
| 4 | `NO_BID` | No Bid | Deliberately declined. **A decision, not an untouched row.** |
| 5 | `REVIEWING` | Reviewing | Draft under internal review. |
| 6 | `APPROVED` | Approved | Cleared to submit. |
| 7 | `SUBMITTED` | Submitted | In the customer's hands. |
| 8 | `ORALS` | Orals | Oral presentations. |
| 9 | `BAFO` | BAFO | Best and final offer. |
| 10 | `WON` | Won | We won it. |
| 11 | `LOST` | Lost | We lost it. |

The user asked for "Awarded"; it is stored and shown as **Won**.

### Two things `pipeline_stage` is NOT

**It is not `opportunities.status`.** That column is the *solicitation's* own
lifecycle as the portal reports it — `NEW / OPEN / AMENDED / CLOSING_SOON /
CLOSED / REMOVED / AWARDED / CANCELLED`. `status = 'AWARDED'` means the agency
awarded the contract **to someone, possibly a competitor**. It must never be
renamed to `WON`; that would claim wins the company did not have.

**It is not `outcome`.** The sheet's "Won/Loss" column is a third axis and it
legitimately disagrees with the stage: eight rows are `SUBMITTED` with an
outcome of `in evalution`, and one is `SUBMITTED` with `Lost`. `outcome` has no
CHECK constraint because real values include `in evalution` and
`RFI no response`, which the 11 stages have no slot for. **The importer never
derives one of these from the other.**

### Retired vocabulary

`deploy/db/migrations/001-pipeline-2026.sql` remaps the old eight-value set:

```
BACKLOG  → IDENTIFIED      REVIEWING  → REVIEWING
DRAFTING → PURSUING        APPROVED   → APPROVED
DECLINED → NO_BID          SUBMITTED  → SUBMITTED
                           WON / LOST → unchanged
```

The importer accepts the retired words too, in case an older copy of the sheet
is ever imported.

---

## 2. The field mapping: 17 sheet columns → the schema

The header row carries the user's own typos — `Contract Vechicle`,
`Cature Stage`. **The importer never matches header text exactly**: it
normalises to lowercase alphanumerics and matches against an alias list, and it
*searches* for the header row rather than assuming one, because the two sheets
disagree (Pipeline's header is on sheet row 2, the forecast sheet's is on row 3
— its row 2 is blank).

| # | Sheet column | Column(s) written | Notes |
|---|---|---|---|
| 0 | Share/No Share | `is_shared` boolean | `Yes`/`No`. Blank → `false`, reported. Never invented as true. |
| 1 | Date found | `date_found` date | **Not `first_seen_at`.** See below. |
| 2 | Agency/POC | `agency`, `poc_raw`, `poc_name`, `poc_email`, `poc_phone`, `department`, `sub_agency`, `state` | The block is split; see below. |
| 3 | Contract Vechicle | `contract_vehicle` | Verbatim (`SAM`, `GSA MAS`, `NY ED`, `Open Source`, `Jaggaer MN`, `Jaggaer PA`). |
| 4 | RFx # | `external_id` + `rfx_number_raw` | Cleaned token keys the row; raw cell kept. |
| 5 | Website | `detail_url` | Not always a URL — see below. |
| 6 | Description | `title` + `description` | **The sheet has no Title column.** See below. |
| 7 | NAICS Code | `naics_code` + `naics_codes` text[] | Cells hold up to two codes. |
| 8 | Period of Performance | `period_of_performance` | Free text; only 2 rows populated. |
| 9 | Estimated Value | `estimated_value` + `estimated_value_text` | See below. |
| 10 | Set-Aside | `set_asides` text[] | `SB`, `SBA OWSB`; forecast rows carry `8(a)`. |
| 11 | Cature Stage | `pipeline_stage` | The 11 codes above. Blank → `IDENTIFIED`, reported. |
| 12 | Status | **`capture_notes`** | ***Never* `status`** — see below. |
| 13 | Questions Due: | `q_and_a_deadline` + `q_and_a_deadline_text` | |
| 14 | Due Date | `due_date` + `due_date_text` | |
| 15 | Won/Loss | `outcome` | No CHECK constraint. |
| 16 | Lessons Learned | `lessons_learned` | Nothing populated it yet. |

Set by the importer, not by a sheet column:

| Column | Value |
|---|---|
| `source_id` | the `manual` source from `deploy/db/seed-sources.sql` |
| `assigned_to` | `users.id` where `name ILIKE 'Richard%'` — this is requirement 3, *"in the pipeline the name should be Richard"*. There is no owner column in the sheet; the app already has `assigned_to → users(id)`, so no text column was added beside it. |
| `status` | derived **on insert only**: due date in the past → `CLOSED`, in the future → `OPEN`, absent → `NEW`. Never overwritten on re-import, because by then the crawler or the app owns it. |
| `content_hash` | SHA-1 of the mapped row. Drives the "unchanged" count. |

### The traps, and what the importer does about each

**The Description cell contains the title.** `opportunities.title` is `NOT NULL`
and there is no Title column: the first line of Description is the title and the
rest is the body. A few cells are title-only (`CIO IT Support`). If a cell has
no line break, the importer cuts at the first sentence end within 200
characters, or truncates with an ellipsis and keeps the whole cell as the
description. A row with **no** Description cannot produce a title and is the one
thing that gets skipped outright — and it is reported.

**`first_seen_at` is not "Date found".** `first_seen_at` is `NOT NULL DEFAULT
now()`, it backs `opp_first_seen_idx`, and it is the default list sort. Writing
a 2025 discovery date into it would sink every imported row below every crawled
one and hand the crawler a fake staleness history. The user's date goes to
`date_found`.

**"Status" must not be named `status`.** The sheet's Status is a free-text
capture log (*"4/3: Sent Antony the opportunity folder… 4/9/26: Proposal
submitted via eVA this morning."*). `opportunities.status` is a CHECK-constrained
enum that ~15 call sites filter on. It is stored as `capture_notes`. In the UI,
label `capture_notes` "Status" (the user's word) and relabel the enum
"Solicitation status", so there are not two columns called Status.

**Agency/POC must not be poured into `agency`.** That column is trigram-indexed,
is one of the three ILIKE targets of the free-text search, and is what the
targeting engine matches agency aliases against. A 279-character block
containing *"Albany, New York 12242"* would match the New York state alias and
pollute both scoring and search. So: the whole block → `poc_raw`; the first
organisation-shaped line → `agency`; email and phone extracted by regex; the
name best-effort (many blocks start with `Contact`, `Issuing Agency` or
`Contracts and Purchasing`, so it is often null, and that is reported).

**Dates are messy and carry time zones.** The cells hold Excel serials
(`46077.5`), US text dates (`3/23/2026 2:00 PM CDT`), prose
(*"Questions due date: June 1, 2026, at 12:00 PM ET."*), a `D Month YYYY` form
(`16 April 2026.`), and one that is simply invalid (`2/825/2026`). Rules:

* Zone abbreviations map to **IANA zones**, not fixed offsets: `EST/EDT/ET →
  America/New_York`, `CST/CDT/CT → America/Chicago`, and so on. The sheet says
  `3/23/2026 2 PM CST` for a date that is really CDT; trusting the
  abbreviation's −6 would put the deadline an hour off the portal's. Default
  zone is Eastern.
* No time of day → **23:59 local**, and it is reported.
* **More than one *different* date in one cell → the typed column is left
  null.** Sheet row 4 holds the due date *and* a Q&A note; sheet row 53 holds an
  original date *and* its extension, in the opposite order. No rule picks
  correctly for both, so neither is guessed — the verbatim cell survives in
  `due_date_text` and the row is reported.
* Several mentions of the *same* day → the one carrying a time wins.
* `date_found` has no paired text column, so an unparseable value (`2/825/2026`)
  becomes null and is reported.
* The `*_text` columns exist to keep a *messy* cell recoverable. A clean date
  serial is not messy, so `due_date_text` stays null for it rather than echoing
  `46077.5` onto the pipeline grid.

**Estimated Value is free text.** The only populated cell is `1.96B BPA`.
`estimated_value` stays `double precision` — `dashboard.ts` sums it and the
targeting value bands compare it numerically — and the importer fills it only
when a magnitude is unambiguous (`K`/`M`/`B` suffixes understood, so `1.96B` →
`1960000000`). The verbatim cell always goes to `estimated_value_text`, and the
interpretation is printed in the report.

**The sheet repeats RFx numbers.** `RFQ1802837` appears twice (two near-identical
DOJ/Federal Prison Industries entries, one No Bid and one Submitted) and
`CR#: 2131174` appears twice (the NY HBITS solicitation logged twice). The
unique constraint `(source_id, external_id)` would reject the second of each, so
duplicates are suffixed `-2` **by order of appearance** — deterministic, so
re-runs stay idempotent. One row has no RFx at all; its `external_id` is derived
from a hash of the title (stable if rows move, which a row-number key would not
be). All of this is reported.

`external_id` is derived without a dictionary of labels: take the first *line*
containing an identifier-shaped token (≥4 characters, contains a digit). That
drops `Notice ID`, `CR#:`, `Solicitation Number` and `BidNetdirect.com` without
naming any of them. Three cells contain no such token at all (`RFI??`,
`Preposal period`, `SWARAS SOURCES SOUGHT`); the raw cell is used and flagged.

**Website is not always a URL.** Two cells are `Email from 3/23/26 from Anita`
and `5/15/26https://www.nyscr.ny.gov/…` (a date accidentally prepended).
`detail_url` is plain text so nothing breaks at the database layer, but **the UI
must only render an `<a href>` when the value parses as `http(s)`** — under
basePath `/procurement` a relative href resolves to a 404 inside the app. Both
are reported.

**NAICS cells hold more than one code.** `54151S & 518210C`,
`541511 Custom Computer Programming Services`, `54151S ` with a trailing space.
`naics_code` (singular) keeps the first for back-compat; `naics_codes` text[]
holds them all. Note `54151S` / `518210C` are GSA SINs, not NAICS, but they are
what the user tracks.

**`naics_codes` and `set_asides` are `text[]`, not `jsonb`.** They are bound as
**raw JS arrays**. They must stay out of the `JSONB` map in
`src/lib/db/query.ts` — stringifying them yields *"malformed array literal"*.
Conversely the only jsonb column on `opportunities` is `score_breakdown`, which
the importer never writes.

### The forecast sheet

`Forecased Opportunities` [sic] → `forecast_opportunities`. It is a **separate
table**, not a flag on `opportunities`: a forecast row has no solicitation
number, no source, no due date, no status and no stage, and all of those are
`NOT NULL` (three of them CHECK-constrained) on `opportunities`.

| Sheet column | Column |
|---|---|
| Date Found | `date_found` |
| Agency | `department` — the parent, e.g. `DOT` |
| Organization | `sub_agency` — the operating administration, e.g. `FMCSA`, `FAA` |
| Title | `title` |
| Link to details | `detail_url` — **trimmed**; two of the four cells have a trailing space that would defeat the unique index |
| Estimated Solicitation Date | `estimated_solicitation_date` |
| Set Aside | `set_asides` text[] |

`promoted_opportunity_id` records the forecast → pipeline hop. The user has
already made that hop once by hand (the 1DOT Digital Services BPA, sheet row
72), but its forecast id (`…/42202`) is not one of the four rows on the forecast
sheet, so **the importer does not link them automatically**. Set it by hand if
you want the trail.

---

## 3. The department matcher

Requirement 1: *"The agencies we have prioritized are DOT, DOI, DOE, VA and HHS.
So we need to add another filter to have the department list it properly."*

`opportunities.department` is a **filter value and a scoring bonus, never a gate
on what may be crawled**. That is why the column has **no CHECK constraint**:
this sheet alone also carries DOJ, GSA, USDA, HUD, DOD, DOL, ED, NSF, FEC, CBO,
ABMC, USAGM, FTC, NIGC, USITC and FMCS.

The matcher lives in **`src/lib/departments.ts`** — the module
`deploy/db/schema.sql` points `department` at — and every writer of that column
imports it: `src/lib/crawl/pipeline.ts`, `src/app/api/targeting/rescore/route.ts`,
`src/app/api/bids/route.ts` and `scripts/import-pipeline-xlsx.mts`.

`scripts/import-pipeline-xlsx.mts` used to carry its own private copy for the
five priority departments. It does not any more, and **a second copy must never
be reintroduced**: the copy shipped exactly the bugs the library exists to
prevent (a bare `\bDOT\b` filed "Virginia DOT" federal, `CMS` filed a Content
Management System under HHS, `NPS` a Net Promoter Score under DOI), and it knew
neither "U.S. Dept. of Transportation" nor "Health & Human Services". The script
still keeps a table for the **non-priority** codes only (DOD, DOJ, GSA, NSF …),
which the library deliberately does not model. Its regression suite is
`scripts/test-departments.mts` (`npx tsx scripts/test-departments.mts`).

### How a row is resolved

Match against the **Agency/POC** cell first, and the **title** second — and that
order is load-bearing in both directions:

* **Never match the description body.** Sheet row 45's body says *"DOE's
  expansive technology environment"* but its POC is `tbenne2@schools.nyc.gov`.
  That DOE is the New York City **Department of Education**, not Energy.
* **The POC alone is not enough either.** Ten rows have `Gsa Market Research` as
  the POC because GSA eBuy is the *vehicle*, while the real customer is named in
  the title (*"DOI - Secure AI Assistant for Final Agency Decisions - MRAS"*).
  So when the POC resolves to GSA, the title gets a say — and `GSA` is last in
  the match order so it only ever wins when nothing more specific did. The fact
  that it came through GSA is already captured by `contract_vehicle`.

Priority departments and the aliases that catch the real rows:

| Code | Matches on |
|---|---|
| **DOT** | `Department of Transportation`, `DOT`, `@dot.gov`, `FAA` `FMCSA` `FHWA` `FTA` `NHTSA` `FRA` `MARAD` `PHMSA` |
| **DOI** | `Department of the Interior`, `DOI`, `@doi.gov`, `ibc.doi.gov`, `BSEE` `BLM` `NPS` `USGS` `BOEM` `BIA` |
| **DOE** | `Department of Energy`, `@doe.gov`, `EIA`, `NNSA` |
| **VA** | `Department of Veterans Affairs`, `VHA` `VBA`, `@va.gov` |
| **HHS** | `Department of Health and Human Services`, `HHS`, `HRSA` `CDC` `NIH` `CMS` `FDA` `ACF` `NCHS` `ASFR` |

`sub_agency` is matched from the same text (`DOT/FAA` → department `DOT`,
sub-agency `FAA`).

### `state`

Requirement 2: *"also the states are only 5, work on it properly."*

`opportunities.state` is derived **only when no federal department matched** — a
mailing address on a federal POC block (`MINOT AFB, ND`) is the contracting
officer's desk, not the opportunity's state. It is read from `NY 10036`-style
zip lines, full state names before a zip, `NY - New York`, `United States,
Arkansas, Pike County`, and `@state.mn.us` / `@pa.gov` domains. The import
derives 9 distinct states from the sheet: **NY LA VA MN AR CA FL PA MA**.

> **The five states are still an open decision, and it is not the importer's to
> make.** There are four disagreeing sources of truth today: the
> `OpportunityFilters` `STATES` array, `src/lib/targeting/defaults.ts` (13
> states), `src/lib/targeting/engine.ts` `STATE_CODES`, and ~20 seeded sources.
> When the five are chosen, narrow the footprint with `is_active = false` on
> `sources` — **never `DELETE`**: `opportunities.source_id` is
> `on delete cascade`, so deleting a source permanently destroys every
> opportunity ever crawled from it, plus its versions, attachments, responses
> and status log.

---

## 4. Running the importer

```bash
# 1. schema first — the 11-stage CHECK and the 18 sheet columns.
#    schema.sql `\ir`-includes deploy/db/migrations/*, so this one command does
#    both the CREATEs and the migrations, in order. It is the SAME command the
#    box's installer runs (deploy/scripts/install.sh in ajace-timesheet-aws),
#    so a normal deploy already applies the migration — no manual step.
npm run db:migrate

# 2. the 'manual' source the rows hang off
npm run seed

# 3. look before you leap (writes nothing)
npx tsx --conditions=react-server scripts/import-pipeline-xlsx.mts --dry-run

# 4. for real
npx tsx --conditions=react-server scripts/import-pipeline-xlsx.mts
```

| Flag | Default | |
|---|---|---|
| `--file <path>` | `~/Downloads/Pipeline_2026.xlsx` | the workbook |
| `--owner <name>` | `Richard` | matched against `users.name ILIKE '<name>%'` |
| `--source <slug>` | `manual` | `sources.slug` the rows hang off |
| `--dry-run` | — | parse and report, write nothing |
| `--verbose` | — | one line per row, not just the exceptions |
| `--help` | | |

**`--conditions=react-server` is required for the write path**, exactly as
`scripts/crawl.mts` is invoked in `package.json`. The write path pulls
`src/lib/db/pg.ts`, which begins `import "server-only"`, and that package's
exports map throws outside the `react-server` condition. The database module is
imported *dynamically*, so a pure `--dry-run` also works under a plain
`npx tsx` with no flag.

Consider adding to `package.json` (not this script's file to edit):

```json
"import-pipeline": "tsx --conditions=react-server scripts/import-pipeline-xlsx.mts"
```

### Safety properties

* **`--dry-run` is forced when `DATABASE_URL` is unset.** The script can never
  fall back to whatever database happens to be configured elsewhere.
* **Idempotent.** Pipeline rows key on the `(source_id, external_id)` unique
  constraint, forecast rows on the partial unique index `forecast_url_key`
  (`detail_url`). The row's `content_hash` is compared before any write, so a
  second run reports `unchanged` and issues no `UPDATE` at all.
* **Nothing is silently dropped.** Every row that could not be *fully* mapped is
  printed with its **sheet row number** (the number Excel shows) and the reason.
  A skipped row is one that produced no database row at all; a "partially
  mapped" row *is* imported, with the fields that could not be trusted named.
* **Per-row failure isolation.** A database error on one row is caught,
  attributed to its sheet row, and reported; the remaining rows still import.
  The process exits `1` if any write failed.
* **Re-import does not clobber the app.** Only sheet-owned columns are updated.
  Deliberately left alone: `status` (the crawler/app owns the solicitation
  lifecycle), `relevance_*`, `pursuit_*`, `urgency`, `score_breakdown` (the
  scoring engines), and `first_seen_at` / `created_at` (history). A stage that
  changed is written to `opportunity_status_log` with
  `changed_by = '<owner>'`.
* **The crawler cannot clobber the import either.** The 18 sheet columns are
  deliberately absent from the `fields` object in `src/lib/crawl/pipeline.ts`,
  which is spread into both the insert *and* the AMENDED update. Do not
  "helpfully" add them there — every re-crawl would then wipe the user's
  hand-typed `capture_notes`, `outcome`, `lessons_learned` and `is_shared`.

### No `xlsx` dependency

This repo has no SheetJS package and `package.json` is not the script's to edit,
so the `.xlsx` — a ZIP of XML — is read directly with `node:zlib`. The reader
handles shared strings, inline strings, formula results, the 1904 date system,
and sparse rows.

#### Verifying the reader

```bash
npx tsx - <<'EOF'
import { createRequire } from "node:module";
const req = createRequire("/path/to/any/project/with/xlsx/x.cjs");
const XLSX = req("xlsx");
const FILE = process.env.HOME + "/Downloads/Pipeline_2026.xlsx";
const { readWorkbook } = await import("./scripts/import-pipeline-xlsx.mts");
const mine = readWorkbook(FILE), ref = XLSX.readFile(FILE);
let cells = 0, diffs = 0;
for (const s of mine.sheets) {
  const rows = XLSX.utils.sheet_to_json(ref.Sheets[s.name], { header: 1, raw: true, defval: null, blankrows: true });
  for (let r = 0; r < Math.max(rows.length, s.grid.length); r++)
    for (let c = 0; c < Math.max((s.grid[r] ?? []).length, (rows[r] ?? []).length); c++) {
      const x = (s.grid[r] ?? [])[c] ?? null, y = ((rows[r] ?? [])[c] ?? null) || null;
      cells++;
      if (!(typeof x === "number" && typeof y === "number" ? Math.abs(x - y) < 1e-9 : x === y)) diffs++;
    }
}
console.log({ cells, diffs });
EOF
```

Last run against SheetJS 0.18.5: **50,665 cells compared, 0 differences.**

---

## 5. Known gaps this import exposes

This section is a **living list, not a historical record.** Several gaps found
during this import were repaired in the same pass; they are recorded in §5.2 as
*fixed* precisely so nobody reads a stale bullet and "restores" the old code.
If you fix something in §5.1, move it down to §5.2 — do not leave it above.

### 5.1 Still open

Not the importer's to fix, but it is what the data proves. Verified still
present at the time of writing:

* **`src/lib/db/analytics.ts:102`** and **`src/lib/db/dashboard.ts:86-87`**
  count only `SUBMITTED`/`WON`/`LOST`, so `ORALS` and `BAFO` — which sit *after*
  `SUBMITTED` in `PIPELINE_STAGE_ORDER` — vanish from `winByBucket` and
  undercount `submitted` on the dashboard. A row at Orals has certainly been
  submitted; both counters should treat every stage at or past `SUBMITTED` as
  submitted rather than string-matching the one stage.
* **`src/lib/targeting/engine.ts:213-215`** scores NAICS with
  `profile.naics.codes.some((c) => input.naicsCode.startsWith(c))`, which cannot
  see the second code in `54151S & 518210C`. `opportunities.naics_codes`
  (`string[]`, `src/lib/types.ts:275`) now exists and is populated by this
  importer — the engine should read it and match if *any* element matches.
  `ScoreInput.naicsCode` (engine.ts:19) is still the single-code field, so this
  needs a plural input as well as a plural comparison.

### 5.2 Found by this import and already fixed — do not revert

Each of these was a real defect that the sheet exposed. The fix is in the tree;
the bullet stays only to stop a future reader re-introducing the bug.

* **`src/lib/ai/generate.ts`** used to write `pipeline_stage: "DRAFTING"` guarded
  on `.in("pipeline_stage", ["BACKLOG","REVIEWING"])` — all retired values that
  the new CHECK rejects, and invisible to `tsc` because the query builder is
  untyped. It now writes `"PURSUING"` guarded on `["IDENTIFIED","QUALIFYING"]`
  (generate.ts:138-142). Note `REVIEWING` is deliberately *not* in the guard any
  more: it preceded `DRAFTING` in the old vocabulary but follows `PURSUING` in
  the new order, so advancing from it would move the row backwards.
* **`src/lib/db/opportunities.ts`** applied `LIMIT` in SQL *before* filtering
  state in JS, so `?state=MA` returned only the MA rows that happened to survive
  the global top-N by `pursuit_score`, and the count badge under-reported. State
  is now filtered in SQL, case-insensitively via `ilike`, across both
  `sources.state` and `opportunities.state`.
* **`src/lib/targeting/defaults.ts`** had DOT, HHS, VA and DOE but **no DOI entry
  at all**, so Interior work — which appears repeatedly in this sheet — scored
  zero agency points. Interior is now present with its aliases and bureaus.
* **`src/components/bids/UploadBidForm.tsx`** exposed 10 of the 17 columns, used
  `datetime-local` for both deadlines (which cannot express `07/23/26  5 PM???`)
  and a numeric input for Estimated Value (which cannot express `1.96B BPA`).
  It now covers all 17 columns, keeps `q_and_a_deadline_text` / `due_date_text`
  as free text with the `datetime-local` fields demoted to optional "exact"
  companions, and takes Estimated Value as free text.
