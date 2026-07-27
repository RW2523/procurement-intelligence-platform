-- =============================================================================
-- Procurement Intelligence — Postgres schema (AWS-native port)
--
-- RECONSTRUCTED FROM THE APPLICATION CODE. The original schema existed only
-- inside the abandoned Supabase project; this repo had zero .sql files. Every
-- column here is justified by a real read, write, filter or order-by in src/.
--
-- Runs in its OWN SCHEMA inside the timesheet database, so both apps share
-- public.auth_users (one login, one cookie, one JWT secret). Procurement's
-- per-app profile + role live in pi_users, mirroring the ts_profiles pattern.
--
-- Idempotent: safe to re-run on every deploy. This file IS the deploy entry
-- point for the database — `deploy/scripts/install.sh` in the ajace-timesheet-aws
-- repo (the box's installer) runs exactly one psql command against it:
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$PROC/deploy/db/schema.sql"
-- and `npm run db:migrate` in THIS repo runs the same thing.
--
-- *** THE CREATEs ONLY BUILD A *FRESH* DATABASE. ***
-- Every table is declared `create table if not exists`, so on a database that
-- already has the table Postgres skips the whole CREATE and any column,
-- constraint or default you change above has NO EFFECT on it. Changes to an
-- EXISTING database must ALSO be written as a migration under
-- `deploy/db/migrations/` AND appended to the `\ir` list at the BOTTOM of this
-- file — that list is the only thing in the tree that ever executes them.
-- Keep the two in lockstep — a fresh install and a migrated database must end
-- up structurally identical.
--
-- *** "STRUCTURALLY IDENTICAL" INCLUDES COLUMN ORDER. ***
-- ALTER TABLE ADD COLUMN can only APPEND, so any column a migration adds lands
-- at the END of the table on an existing database, and no DDL moves it without
-- rewriting the table. A CREATE TABLE here that declares the same column
-- mid-table therefore produces a fresh box whose columns are all present but at
-- different ORDINAL POSITIONS from the migrated one. Nothing queried breaks —
-- every insert in this tree names its columns — but `select *` ordering and
-- pg_dump output diverge between two installs that are meant to be
-- interchangeable, and a future `pg_dump --schema-only | diff` between them
-- reports changes that are not really there.
-- So: WHEN A MIGRATION ADDS COLUMNS, DECLARE THEM AT THE END OF THE CREATE HERE
-- TOO, in the migration's own order — not in whatever position reads most
-- nicely. The Pipeline_2026 block at the end of `opportunities` is exactly this
-- and carries a matching warning; it was moved there from mid-table for this
-- reason. Verified equal with:
--   select attnum, attname from pg_attribute
--    where attrelid='public.opportunities'::regclass and attnum>0 and not attisdropped
--    order by attnum;   -- run on a fresh box and a migrated box; must match.
-- =============================================================================

create extension if not exists pgcrypto;
-- pgvector backs company_knowledge_chunks.embedding and the <=> cosine search.
-- HARD REQUIREMENT for the Knowledge Library and style-matched drafting.
create extension if not exists vector;
-- trigram indexes for the unanchored ILIKE %term% opportunity search
create extension if not exists pg_trgm;

-- The procurement account/profile row. The app resolves the signed-in identity to this
-- table BY EMAIL (never by id), so the port keeps it intact and joins auth_users on email.
create table if not exists public.users (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  email      text not null unique,
  role       text not null default 'viewer'
             check (role in ('admin','writer','approver','viewer')),
  avatar_url text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists users_email_key on public.users (email);

create table if not exists public.sources (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  slug                 text not null unique,
  state                text,
  base_url             text not null,
  connector_type       text not null default 'static_html'
                       check (connector_type in ('json_api','static_html','aspnet_viewstate',
                                                 'jsf_playwright','playwright','custom')),
  connector_key        text,
  schedule_cron        text not null default '0 6 * * *',
  timezone             text not null default 'America/New_York',
  requires_auth        boolean not null default false,
  credential_ref       text,
  is_active            boolean not null default true,
  status               text not null default 'active'
                       check (status in ('active','paused','error','needs_connector')),
  notes                text,
  last_run_at          timestamptz,
  last_success_at      timestamptz,
  consecutive_failures integer not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index if not exists sources_slug_key on public.sources (slug);
-- stalest-first rotation, src/lib/crawl/runner.ts:33-38
create index if not exists sources_active_stalest_idx on public.sources (is_active, last_success_at nulls first, last_run_at nulls first, name);

create table if not exists public.opportunities (
  id                   uuid primary key default gen_random_uuid(),
  source_id            uuid not null references public.sources(id) on delete cascade,
  external_id          text not null,
  title                text not null,
  agency               text,
  category             text,
  naics_code           text,
  description          text,
  posted_date          date,                    -- .slice(0,10) before write ⇒ DATE, not timestamptz
  due_date             timestamptz,
  q_and_a_deadline     timestamptz,
  estimated_value      double precision,
  detail_url           text,
  status               text not null default 'NEW'
                       check (status in ('NEW','OPEN','AMENDED','CLOSING_SOON',
                                         'CLOSED','REMOVED','AWARDED','CANCELLED')),
  -- OUR capture/proposal phase. A DIFFERENT AXIS from `status` above: that one is
  -- the solicitation's own lifecycle as reported by the portal, where 'AWARDED'
  -- means the agency awarded to SOMEONE (possibly a competitor). 'WON' here means
  -- we won it. Order = src/lib/types.ts PIPELINE_STAGES. Retired vocabulary
  -- (BACKLOG/DRAFTING/DECLINED) is remapped by migrations/001-pipeline-2026.sql.
  pipeline_stage       text not null default 'IDENTIFIED'
                       check (pipeline_stage in ('IDENTIFIED','QUALIFYING','PURSUING','NO_BID',
                                                 'REVIEWING','APPROVED','SUBMITTED','ORALS',
                                                 'BAFO','WON','LOST')),
  relevance_score      integer,   -- NO range CHECK: the engine legitimately emits >100
  relevance_reason     text,
  bid_recommendation   text check (bid_recommendation in ('BID','REVIEW','NO_BID')),
  relevance_method     text not null default 'keyword'
                       check (relevance_method in ('keyword','engine','llm')),
  -- ── weighted targeting engine (docs/TARGETING-ENGINE-PLAN.md §2) ──
  pursuit_score        integer,                 -- raw, UNCAPPED (can exceed 100)
  pursuit_bucket       text check (pursuit_bucket in ('PURSUE','CAPTURE_REVIEW',
                                                      'MANUAL_REVIEW','IGNORE')),
  urgency              text check (urgency in ('URGENT','STANDARD','EARLY_CAPTURE',
                                               'INSUFFICIENT_TIME','NO_DATE')),
  set_asides           text[] not null default '{}',   -- text[] — bind RAW, never JSON.stringify
  contract_vehicle     text,
  solicitation_type    text,
  agency_priority      boolean not null default false,
  excluded_reason      text,
  score_breakdown      jsonb,                   -- ARRAY of objects — MUST be JSON.stringify'd

  content_hash         text not null,
  assigned_to          uuid references public.users(id) on delete set null,
  documents_checked_at timestamptz,
  first_seen_at        timestamptz not null default now(),
  last_seen_at         timestamptz not null default now(),
  closed_at            timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  -- ── Pipeline_2026 spreadsheet columns — LAST IN THE TABLE ON PURPOSE ────────
  -- *** DO NOT TIDY THESE BACK UP NEXT TO THE OTHER CONTENT COLUMNS. ***
  -- They sit after updated_at so that a FRESH install and a MIGRATED box agree
  -- on ORDINAL POSITION, not just on the set of columns.
  -- migrations/001-pipeline-2026.sql adds them with ALTER TABLE ADD COLUMN,
  -- which can only APPEND — on the existing RDS box they land after updated_at
  -- and no DDL can move them without rewriting the table. This block used to be
  -- declared mid-table (just before content_hash), so the two boxes ended up
  -- with the same 18 columns at different attnums: every query behaved
  -- identically, but `select *` column order and pg_dump output differed between
  -- two installs that are supposed to be interchangeable, which turns any future
  -- schema diff between them into a false positive. Declaring them last here
  -- costs nothing (it only affects databases created from scratch) and makes the
  -- two paths byte-identical in pg_dump.
  -- THE ORDER OF THE 18 BELOW MUST MATCH STEP 1 OF
  -- migrations/001-pipeline-2026.sql EXACTLY.
  --
  -- The 18 hand-entry columns of the user's real workbook. These are
  -- HAND-ENTERED and are deliberately absent from the crawler's `fields` object
  -- (src/lib/crawl/pipeline.ts:107-130), which is spread into both the insert AND
  -- the AMENDED update — adding them there would wipe the user's typing on every
  -- re-crawl. Every one is nullable (or defaulted) so existing rows are
  -- unaffected.
  --
  -- "Share/No Share": is this pursuit shared with teaming partners. Sheet holds
  -- exactly 'Yes'/'No', so boolean, not text.
  is_shared            boolean not null default false,
  -- "Date found": the human's own discovery date, NOT first_seen_at. first_seen_at
  -- is `default now()`, backs opp_first_seen_idx and IS the default list sort —
  -- writing a 2025 discovery date into it would sink every imported row below
  -- every crawled one and hand the crawler a fake staleness history. date, not
  -- timestamptz: the cells carry no time of day.
  date_found           date,
  -- Parent department ('DOT','DOI','DOE','VA','HHS', …). NO CHECK CONSTRAINT ON
  -- PURPOSE: the 5 priority departments are a FILTER + a scoring bonus, never a
  -- gate on what may be crawled — this sheet alone also contains DOJ, GSA, USDA,
  -- HUD, Navy, NSF, FEC. Populated by the matcher in src/lib/departments.ts.
  department           text,
  -- Operating administration below `department` — the 'FAA' of "DOT/FAA", and the
  -- forecast sheet's "Organization" column.
  sub_agency           text,
  -- USPS code for HAND-ENTERED rows. Needed because the state filter reads
  -- sources.state, and the 'manual' source is seeded with state = null, so every
  -- typed-in row is invisible to it. Uppercase by convention; nothing coerces it.
  state                text,
  -- "Agency/POC" verbatim: a multi-line contact block, up to ~280 chars. It must
  -- NOT be poured into `agency` — that column is trigram-indexed, is one of the
  -- three ILIKE targets of the free-text search, and is what the targeting engine
  -- matches agency aliases against; a block containing "Albany, New York 12242"
  -- would match the New York state alias and pollute scoring and search alike.
  poc_raw              text,
  poc_name             text,                    -- parsed best-effort; often null
  poc_email            text,
  poc_phone            text,
  -- "RFx #" verbatim (newlines, two numbers in one cell). The CLEANED token goes
  -- to external_id, which is half of the unique (source_id, external_id) key.
  rfx_number_raw       text,
  -- "NAICS Code" holds MULTIPLE codes per cell ("54151S & 518210C") and sometimes
  -- a code plus its name. naics_code (singular, text) stays as the primary for
  -- back-compat; this array is what a multi-code matcher should score against.
  -- text[] — bind RAW, never JSON.stringify. MUST NOT be added to the JSONB map
  -- in src/lib/db/query.ts: stringifying yields "malformed array literal".
  naics_codes          text[] not null default '{}',
  -- "Period of Performance": free text, e.g. '09/25/2026 - 09/24/2031'. A date
  -- range type would be over-engineering — only 2 of 71 rows are populated.
  period_of_performance text,
  -- "Estimated Value" VERBATIM, e.g. '1.96B BPA'. estimated_value (double
  -- precision, above) is KEPT and stays the numeric axis — dashboard.ts sums it
  -- and the targeting valueBands compare it numerically — but it is null whenever
  -- the cell will not parse, which is why the raw string needs its own home.
  estimated_value_text text,
  -- "Questions Due:" / "Due Date" VERBATIM. The typed timestamptz columns above
  -- stay authoritative (they drive opp_due_date_idx, the urgency bands,
  -- CLOSING_SOON and the deadline notifications), but the cells are messy —
  -- '07/23/26  5 PM???', two dates in one cell (original + extension), embedded
  -- Q&A instructions, explicit EST/EDT/CT zones. Keeping the raw string makes a
  -- bad parse recoverable and auditable instead of silently wrong by 4-6 hours.
  q_and_a_deadline_text text,
  due_date_text        text,
  -- The sheet's "Status" column: a free-text capture/follow-up log
  -- ('4/9/26: Proposal submitted via eVA this morning.'). *** DO NOT NAME THIS
  -- `status` *** — that name is taken by the enum above, ~15 call sites filter on
  -- it, and the first import would either raise a CHECK violation or silently
  -- change the meaning of every one of those queries.
  capture_notes        text,
  -- "Won/Loss". NO CHECK CONSTRAINT: the real values include 'in evalution ' and
  -- 'RFI no response', which the 11-stage vocabulary has no slot for. This is a
  -- SEPARATE AXIS from pipeline_stage and the two legitimately disagree (8 rows
  -- are stage=Submitted with outcome='in evalution'); do not derive either.
  outcome              text,
  lessons_learned      text,

  constraint opportunities_source_external_key unique (source_id, external_id)
);
create unique index if not exists opportunities_source_external_key on public.opportunities (source_id, external_id);
-- default list sort, src/lib/db/opportunities.ts:91
create index if not exists opp_first_seen_idx on public.opportunities (first_seen_at desc);
-- src/lib/db/opportunities.ts:88-90 sort=relevance | score | due_date
create index if not exists opp_relevance_idx on public.opportunities (relevance_score desc nulls last);
create index if not exists opp_pursuit_idx on public.opportunities (pursuit_score desc nulls last);
create index if not exists opp_due_date_idx on public.opportunities (due_date asc nulls last);
-- docs/TARGETING-ENGINE-PLAN.md:63
create index if not exists opp_bucket_idx on public.opportunities (pursuit_bucket);
-- crawl match key + per-source health, src/lib/crawl/pipeline.ts:73-75, src/lib/db/sources.ts:21
create index if not exists opp_source_status_idx on public.opportunities (source_id, status);
create index if not exists opp_pipeline_stage_idx on public.opportunities (pipeline_stage);
create index if not exists opp_assigned_to_idx on public.opportunities (assigned_to) where assigned_to is not null;
-- the targeting rescore loop scans `.is('pursuit_bucket', null)`, src/app/api/targeting/rescore/route.ts:50,122
create index if not exists opp_unscored_idx on public.opportunities (first_seen_at desc) where pursuit_bucket is null;
-- the LLM rescore loop scans `.neq('relevance_method','llm')`, src/app/api/relevance/rescore/route.ts:39,92
create index if not exists opp_not_llm_idx on public.opportunities (created_at) where relevance_method <> 'llm';
-- the document backfill scans `.is('documents_checked_at', null)`, src/app/api/documents/backfill/route.ts:33
create index if not exists opp_docs_unchecked_idx on public.opportunities (relevance_score desc) where documents_checked_at is null;
-- free-text search: title/agency/external_id ILIKE %term%, src/lib/db/opportunities.ts:83-86
create index if not exists opp_title_trgm_idx on public.opportunities using gin (title gin_trgm_ops);
create index if not exists opp_agency_trgm_idx on public.opportunities using gin (agency gin_trgm_ops);
create index if not exists opp_external_id_trgm_idx on public.opportunities using gin (external_id gin_trgm_ops);
-- ── Pipeline_2026 filters ────────────────────────────────────────────────────
-- The indexes on department / state / is_shared / date_found are NOT here. They
-- reference columns that only exist after the migrations, and on an already-
-- populated database `create table if not exists opportunities` above is skipped
-- so those columns are not yet there. Placing them here aborted the whole file
-- ("ERROR: column "department" does not exist") before the migration chain at the
-- bottom could add them — under install.sh's `-v ON_ERROR_STOP=1` that failed the
-- deploy outright. They now live below the `\ir` chain at the end of this file.

-- =============================================================================
-- Forecast opportunities — the workbook's "Forecased Opportunities" [sic] sheet.
--
-- WHY A SEPARATE TABLE, not a flag on `opportunities`: a forecast row has no
-- solicitation number, no source, no due date, no status and no stage — and on
-- `opportunities` source_id, external_id, title, status, pipeline_stage and
-- content_hash are all NOT NULL, three of them CHECK-constrained. Modelling a
-- forecast there would mean inventing fake values for six required columns.
--
-- The workflow the sheet actually shows is forecast → real solicitation:
-- `promoted_opportunity_id` records that hop (the user has already done it once
-- by hand, for the DOT Digital Services BPA).
-- =============================================================================
create table if not exists public.forecast_opportunities (
  id                          uuid primary key default gen_random_uuid(),
  date_found                  date,            -- sheet "Date Found"
  -- sheet "Agency"       — the parent department, e.g. 'DOT'. Same vocabulary as
  -- opportunities.department, and same reason for having no CHECK constraint.
  department                  text,
  -- sheet "Organization" — the operating administration, e.g. 'FMCSA', 'FAA'.
  sub_agency                  text,
  title                       text not null,   -- sheet "Title"
  -- sheet "Link to details". trim() on import: two of the four cells have a
  -- trailing space, which would defeat the unique index below.
  detail_url                  text,
  estimated_solicitation_date date,            -- sheet "Estimated Solicitation Date"
  -- sheet "Set Aside" ('8(a)'). text[] — bind RAW, never JSON.stringify, and it
  -- MUST NOT be added to the JSONB map in src/lib/db/query.ts.
  set_asides                  text[] not null default '{}',
  notes                       text,
  -- set once this forecast becomes a real solicitation we entered in the pipeline
  promoted_opportunity_id     uuid references public.opportunities(id) on delete set null,
  created_by                  uuid references public.users(id) on delete set null,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);
-- default sort: what is coming up soonest
create index if not exists forecast_solicitation_idx on public.forecast_opportunities (estimated_solicitation_date asc nulls last);
create index if not exists forecast_department_idx on public.forecast_opportunities (department);
-- import idempotency key. Partial, because detail_url is nullable and multiple
-- NULLs must stay legal.
create unique index if not exists forecast_url_key on public.forecast_opportunities (detail_url) where detail_url is not null;

create table if not exists public.opportunity_versions (
  id            uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  version_no    integer not null,
  snapshot_json jsonb not null default '{}'::jsonb,   -- MUST be JSON.stringify'd on write
  content_hash  text not null,
  change_summary text,
  captured_at   timestamptz not null default now(),
  constraint opportunity_versions_opp_version_key unique (opportunity_id, version_no)
);
create unique index if not exists opportunity_versions_opp_version_key on public.opportunity_versions (opportunity_id, version_no);
-- src/lib/db/opportunities.ts:130-133 and src/lib/crawl/pipeline.ts:205-209
create index if not exists opp_versions_opp_idx on public.opportunity_versions (opportunity_id, version_no desc);

create table if not exists public.opportunity_status_log (
  id            uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  field         text not null check (field in ('status','pipeline_stage')),
  old_value     text,
  new_value     text,
  changed_by    text not null default 'system',   -- free text ('system'/'user'/user.name), NOT a uuid FK
  reason        text,
  changed_at    timestamptz not null default now()
);
-- audit trail on the detail page, src/lib/db/opportunities.ts:140-143
create index if not exists opp_status_log_opp_idx on public.opportunity_status_log (opportunity_id, changed_at desc);
-- analytics cycle-time query filters field + new_value, src/lib/db/analytics.ts:47-51
create index if not exists opp_status_log_field_value_idx on public.opportunity_status_log (field, new_value);

create table if not exists public.attachments (
  id            uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  filename      text not null,
  source_url    text,
  storage_path  text,        -- CURRENT: object-store key written by the download path
  storage_url   text,        -- LEGACY: never written, but SELECTed — must exist or queries error
  file_type     text,        -- LEGACY: never written, but SELECTed — must exist or queries error
  file_base64   text,        -- LEGACY: pre-Storage bytes; still read as a fallback
  content_type  text,
  byte_size     integer,
  parsed_text   text,
  parse_status  text not null default 'pending'
                check (parse_status in ('pending','parsed','stored','failed','too_large')),
  fetch_error   text,
  downloaded_at timestamptz,
  created_at    timestamptz not null default now()
);
-- src/lib/db/opportunities.ts:120-123, src/app/api/opportunities/[id]/documents/route.ts:16
create index if not exists attachments_opp_idx on public.attachments (opportunity_id, created_at);
-- pending-download scan, src/lib/crawl/attachments.ts:308-314
create index if not exists attachments_pending_idx on public.attachments (opportunity_id) where downloaded_at is null and source_url is not null;

create table if not exists public.responses (
  id            uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  mode          text not null check (mode in ('STYLE_MATCHED','LLM_ORIGINAL')),
  version_no    integer not null default 1,
  title         text,
  content       text not null default '',
  model_used    text,
  prompt_used   text,
  status        text not null default 'DRAFT'
                check (status in ('DRAFT','IN_REVIEW','APPROVED','SUBMITTED','REJECTED')),
  created_by    uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
-- src/lib/db/responses.ts:7-10 and the version_no count at src/lib/ai/generate.ts:102-106
create index if not exists responses_opp_idx on public.responses (opportunity_id, created_at desc);
create index if not exists responses_opp_mode_idx on public.responses (opportunity_id, mode);

create table if not exists public.response_revisions (
  id               uuid primary key default gen_random_uuid(),
  response_id      uuid not null references public.responses(id) on delete cascade,
  revision_no      integer not null,
  instruction      text not null,
  previous_content text,
  revised_content  text,
  model_used       text,
  revised_by       uuid references public.users(id) on delete set null,
  revised_at       timestamptz not null default now(),
  constraint response_revisions_resp_rev_key unique (response_id, revision_no)
);
create unique index if not exists response_revisions_resp_rev_key on public.response_revisions (response_id, revision_no);
-- src/lib/db/responses.ts:23-26
create index if not exists response_revisions_resp_idx on public.response_revisions (response_id, revision_no desc);

create table if not exists public.company_knowledge (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  file_url    text,
  parsed_text text,
  outcome     text not null default 'unknown' check (outcome in ('won','lost','unknown')),
  category    text,
  tags        text[] not null default '{}',   -- text[] — bind RAW, never JSON.stringify
  embedded    boolean not null default false,
  created_by  uuid references public.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
-- src/lib/db/knowledge.ts:13
create index if not exists company_knowledge_created_idx on public.company_knowledge (created_at desc);

-- requires: create extension if not exists vector;
create table if not exists public.company_knowledge_chunks (
  id           uuid primary key default gen_random_uuid(),
  knowledge_id uuid not null references public.company_knowledge(id) on delete cascade,
  chunk_no     integer not null,
  content      text not null,
  embedding    vector(1536) not null,   -- bind the '[0.1,0.2,…]' TEXT literal RAW
  created_at   timestamptz not null default now(),
  constraint company_knowledge_chunks_kid_no_key unique (knowledge_id, chunk_no)
);
create unique index if not exists company_knowledge_chunks_kid_no_key on public.company_knowledge_chunks (knowledge_id, chunk_no);
-- delete-by-parent on re-ingest, src/lib/ai/ingest.ts:29
create index if not exists company_knowledge_chunks_kid_idx on public.company_knowledge_chunks (knowledge_id);
-- cosine ANN for match_knowledge_chunks (<=> operator). OPTIONAL at this corpus size —
-- with a handful of proposals a seq scan is faster; build it only once the library grows.
-- HNSW build is memory-hungry on a db.t4g.micro: raise maintenance_work_mem for the build.
create index if not exists company_knowledge_chunks_embedding_idx
  on public.company_knowledge_chunks using hnsw (embedding vector_cosine_ops);

create table if not exists public.crawl_runs (
  id            uuid primary key default gen_random_uuid(),
  source_id     uuid not null references public.sources(id) on delete cascade,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running'
                check (status in ('running','success','partial','failed')),
  items_found   integer not null default 0,
  new_count     integer not null default 0,
  changed_count integer not null default 0,
  closed_count  integer not null default 0,
  error_count   integer not null default 0,
  duration_ms   integer,
  log           text,
  "trigger"     text not null default 'manual' check ("trigger" in ('manual','scheduled'))
);
-- per-source run history, src/lib/db/sources.ts:50-54
create index if not exists crawl_runs_source_idx on public.crawl_runs (source_id, started_at desc);
-- global recent-runs feed, src/lib/db/sources.ts:22,93-96 and src/lib/db/analytics.ts:46
create index if not exists crawl_runs_started_idx on public.crawl_runs (started_at desc);

create table if not exists public.notifications (
  id            uuid primary key default gen_random_uuid(),
  type          text not null
                check (type in ('NEW_OPPORTUNITY','AMENDMENT','DEADLINE','QA_DEADLINE',
                                'CRAWL_FAILURE','RESPONSE_APPROVED','STATUS_CHANGE')),
  title         text not null,
  body          text,
  opportunity_id uuid references public.opportunities(id) on delete cascade,
  source_id     uuid references public.sources(id) on delete cascade,
  user_id       uuid references public.users(id) on delete cascade,
  is_read       boolean not null default false,
  severity      text not null default 'info'
                check (severity in ('info','warning','critical')),
  created_at    timestamptz not null default now()
);
-- src/lib/db/notifications.ts:9-10
create index if not exists notifications_created_idx on public.notifications (created_at desc);
-- unread badge count, src/lib/db/notifications.ts:16-19
create index if not exists notifications_unread_idx on public.notifications (created_at desc) where is_read = false;
-- reminder dedupe probe, src/lib/notify/deadlines.ts:61-67
create index if not exists notifications_opp_type_idx on public.notifications (opportunity_id, type);

create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,          -- MUST be JSON.stringify'd before binding
  updated_at timestamptz not null default now()
);

create table if not exists public.targeting_profile_versions (
  id         uuid primary key default gen_random_uuid(),
  version_no integer not null,
  profile    jsonb not null,          -- MUST be JSON.stringify'd before binding
  changed_by text not null default 'admin',
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists targeting_profile_versions_created_idx on public.targeting_profile_versions (created_at desc);

-- ---------- procurement access ------------------------------------------------
-- There is deliberately NO second profile table: `users` above IS the
-- procurement profile, and every FK (opportunities.assigned_to,
-- responses.created_by, …) already points at it. A person can therefore hold an
-- AJACE login and still have NO procurement access — which is the intent.
create unique index if not exists users_email_lower_idx on public.users (lower(email));

-- Audit trail for PRIVILEGE changes, modelled on opportunity_status_log above:
-- append-only, old_value/new_value, free-text actor (never an FK, so the record
-- survives the actor's own row being removed). Granting procurement access is a
-- privilege change; it must be attributable after the fact, from either the
-- admin screen (/admin/access) or scripts/grant-procurement-access.mts.
create table if not exists public.user_access_log (
  id            uuid primary key default gen_random_uuid(),
  target_email  text not null,          -- email, not a uuid FK: the row may not exist yet (GRANT) or may be gone (REVOKE)
  action        text not null check (action in ('GRANT','ROLE_CHANGE','REVOKE','DEACTIVATE','REACTIVATE')),
  old_value     text,
  new_value     text,
  actor         text not null default 'system',   -- 'script:<user>@<host>' or the admin's email
  reason        text,
  changed_at    timestamptz not null default now()
);
create index if not exists user_access_log_target_idx on public.user_access_log (lower(target_email), changed_at desc);
create index if not exists user_access_log_changed_idx on public.user_access_log (changed_at desc);

-- BOOTSTRAP THE FIRST ADMIN.
-- Without this the app cannot onboard anybody, including its owner: access is a
-- `users` row, and creating the first one needed hand-written SQL. This runs on
-- every deploy and is idempotent in both directions:
--   * `where not exists (… role='admin' and is_active)` — it only fires when the
--     install has NO usable admin, so it never re-promotes someone an operator
--     deliberately demoted, and never overwrites Richard's row if it changed.
--   * `on conflict (lower(email)) do update` — Richard may already exist as a
--     viewer, or deactivated. `do nothing` there would leave an install with NO
--     admin and no way in, which is the exact failure this block exists to
--     prevent; the guard above has already established that nobody can
--     administer, so promoting the bootstrap address is the only correct outcome.
--
--     THE ARBITER MUST BE `lower(email)`, NOT `email`. `users` carries TWO unique
--     indexes on the address: users_email_key on the raw text (line 68) and
--     users_email_lower_idx on lower(email) (line 506). The row is not guaranteed
--     to be spelled in lower case — grantAccess() stores the LOGIN's spelling of
--     the address (`login?.email ?? email`, src/lib/db/access.ts), so an account
--     created from an auth_users row reading 'Richard@AJACE.com' is stored exactly
--     that way. Arbitrating on `email` then matches nothing (the literal below is
--     lower case, the stored value is not), the ON CONFLICT branch is never
--     reached, and the insert violates users_email_lower_idx instead — a hard
--     ERROR that aborts the whole schema.sql transaction, on precisely the
--     locked-out install this block exists to repair. Arbitrating on lower(email)
--     covers both spellings: an exactly-lower-case row conflicts on both indexes
--     and is still caught, and DO UPDATE never rewrites `email`, so the login's
--     spelling survives and users_email_key cannot be violated by the update.
-- Use scripts/grant-procurement-access.mts (or /admin/access) for everyone else.
--
-- *** THE AUDIT ROW IS WRITTEN BY THIS SAME STATEMENT, FROM ITS RETURNING. ***
-- It has to be, and a separate guarded INSERT cannot do it. The audit INSERT
-- used to stand on its own and fire `where exists (… richard is admin) and not
-- exists (… actor = 'schema.sql')` — conditions about the STATE of the database,
-- not about whether THIS deploy changed anything. On any install where Richard
-- already held admin because a human promoted him through /admin/access (which
-- logs actor = that admin's email, never 'schema.sql'), both conditions hold
-- forever, so the first deploy to run this block appended a GRANT dated today
-- for a promotion somebody else performed days earlier. The users INSERT above
-- did nothing on that deploy — its own `where not exists` saw a usable admin —
-- yet the log gained an event that never happened, and `who granted this?` then
-- has two contradictory answers. An audit trail that records non-events is
-- worse than no audit trail.
-- Chaining the log off `returning` removes the possibility: the CTE emits a row
-- only when the INSERT actually inserted, or the ON CONFLICT branch actually
-- promoted/reactivated Richard, so exactly one audit row is written per real
-- bootstrap and none at all on a routine no-op deploy. That also drops the
-- `actor = 'schema.sql'` dedupe, deliberately: if an operator later strips every
-- active admin and a subsequent deploy re-promotes Richard, that is a second
-- genuine privilege change and the append-only log should say so.
-- `prior` reads the pre-INSERT snapshot (all CTE parts of one statement see the
-- same snapshot), so old_value is Richard's real previous role — or NULL when
-- the row did not exist yet.
with prior as (
  select role
    from public.users
   where lower(email) = 'richard@ajace.com'
),
bootstrapped as (
  insert into public.users (name, email, role)
  select 'Richard', 'richard@ajace.com', 'admin'
   where not exists (
     select 1 from public.users where role = 'admin' and is_active
   )
  on conflict (lower(email)) do update
     set role = 'admin', is_active = true, updated_at = now()
  returning email
)
insert into public.user_access_log (target_email, action, old_value, new_value, actor, reason)
select bootstrapped.email,
       'GRANT',
       (select role from prior),
       'admin',
       'schema.sql',
       case
         when not exists (select 1 from prior) then 'first-admin bootstrap: created the account'
         else 'first-admin bootstrap: promoted the existing account (no usable admin remained)'
       end
  from bootstrapped;

-- ---------- pgvector similarity search ---------------------------------------
-- Reconstruction of the match_knowledge_chunks RPC the Knowledge Library calls.
-- Returns the most similar chunks by cosine distance.
create or replace function public.match_knowledge_chunks(
  query_embedding vector(1536),
  match_count     integer default 8,
  min_similarity  double precision default 0.0
)
-- The column set is dictated by RetrievedChunk in src/lib/ai/rag.ts:4 —
-- chunk_id, knowledge_id, title, outcome, content, similarity. My first
-- reconstruction returned (id, knowledge_id, content, similarity), which does
-- not error: the missing fields simply arrive as undefined, so the drafting
-- prompt silently loses the past-proposal TITLE and its WON/LOST outcome. That
-- outcome is the whole point of style-matched drafting — without it the model is
-- shown examples with no idea which ones actually won.
returns table (
  chunk_id     uuid,
  knowledge_id uuid,
  title        text,
  outcome      text,
  content      text,
  similarity   double precision
)
language sql stable as $$
  select c.id                                   as chunk_id,
         c.knowledge_id,
         k.title,
         coalesce(k.outcome, 'unknown')         as outcome,
         c.content,
         1 - (c.embedding <=> query_embedding)   as similarity
    from public.company_knowledge_chunks c
    join public.company_knowledge k on k.id = c.knowledge_id
   where 1 - (c.embedding <=> query_embedding) >= min_similarity
   order by c.embedding <=> query_embedding
   limit greatest(1, match_count);
$$;

-- =============================================================================
-- MIGRATIONS — the part that fixes an ALREADY-EXISTING database.
--
-- WHY THIS BLOCK EXISTS
--   Everything above is `create table if not exists`. On the live RDS instance
--   the tables already exist, so Postgres skips those CREATEs entirely and a
--   column/constraint/default edited above never reaches production. Without
--   this block `deploy/db/migrations/` was dead weight: nothing in either repo
--   referenced it, so the box kept the old 8-value pipeline_stage CHECK and the
--   'BACKLOG' default while the new build wrote IDENTIFIED / QUALIFYING /
--   PURSUING / NO_BID / ORALS / BAFO — a bare CHECK violation on the first
--   board drag and on every crawl insert.
--
--   The installer runs ONE psql command, and it points here. So this file is
--   where the migrations have to be chained: applying the schema now applies
--   the migrations, in order, automatically, on every deploy.
--
-- RULES FOR ADDING A MIGRATION — all four, every time:
--   1. Write `deploy/db/migrations/NNN-name.sql`.
--   2. Make it IDEMPOTENT *AND CHEAP ON RE-RUN*. This list is unconditional:
--      every file runs on every deploy, forever, so a statement that is merely
--      "harmless to repeat" is still a cost you pay on every single deploy.
--      `add column if not exists`, `create ... if not exists`, and UPDATEs whose
--      WHERE matches nothing on a second pass are all genuinely free.
--      DROP-THEN-ADD FOR A CONSTRAINT IS NOT — Postgres has no
--      `add constraint if not exists`, and the ADD re-validates every row in the
--      table under ACCESS EXCLUSIVE (44 ms on a 200k-row / 172 MB scratch copy
--      of `opportunities`, and it grows with the table). Check the catalogue and
--      keep the constraint when it is already correct; see STEP 2a of
--      001-pipeline-2026.sql for the pattern, including why the check has to
--      compare the constraint's MEANING rather than its definition string.
--      Same rule for any full-table verification scan: guard it.
--      There is deliberately no schema_migrations ledger — re-runnability is
--      enforced by review, not by bookkeeping.
--   3. BOUND ITS LOCKS. If it touches a table the running app touches — above
--      all `opportunities` — open with `set local lock_timeout = '5s';` (plus a
--      generous `statement_timeout`) inside the transaction. This runs against a
--      LIVE database on every deploy. An ALTER TABLE holds ACCESS EXCLUSIVE, and
--      a request for that lock queues AHEAD of every read and write that arrives
--      after it, so a migration waiting on one open crawler transaction stalls
--      the whole app for as long as that transaction lasts. Measured at 17s of
--      blocked ordinary SELECTs from a single 20s holder. With lock_timeout the
--      deploy fails fast and rolls back instead, which is the outcome you want:
--      re-run it when the database is quiet. See 001-pipeline-2026.sql STEP 0.
--   4. APPEND it below. Order is execution order; never reorder or remove a
--      line, because a fresh box replays the whole list from empty.
--   Also mirror the end state into the CREATEs above, so a fresh install and a
--   migrated database come out structurally identical — with ONE exception:
--
-- *** ANY STATEMENT THAT NAMES A MIGRATION-ADDED COLUMN MUST SIT BELOW THE \ir
--     CHAIN, NOT IN THE CREATEs ABOVE. ***
--   A column added by a migration is inside a `create table if not exists` up
--   there, which Postgres skips wholesale on an existing database — so the column
--   does not exist yet when the CREATEs run. A standalone statement that names it
--   (a CREATE INDEX, a partial-index predicate, a view) therefore fails with
--   `column "x" does not exist`, and because install.sh applies this file with
--   `-v ON_ERROR_STOP=1`, psql exits non-zero right there and the chain below
--   never runs — the deploy fails and the migration silently never happens. That
--   is exactly what the four Pipeline_2026 indexes did before they were moved
--   underneath the chain. Tables and columns go above; anything that *reads* a
--   migrated column goes after.
--
-- `\ir` resolves relative to THIS file, so the chain works from any cwd. It is
-- a psql meta-command: this schema must be applied with psql (as install.sh,
-- `npm run db:migrate` and `npm run seed` all do), not piped through node-pg.
-- =============================================================================

\ir migrations/001-pipeline-2026.sql

-- ── Pipeline_2026 filter indexes — AFTER the chain, deliberately ─────────────
-- These name columns the migration above adds, so they cannot live up in the
-- opportunities block: on an existing database that block is skipped and the
-- columns do not exist yet. 001-pipeline-2026.sql already creates all four, so
-- on both a fresh and a migrated box these are no-ops; they are kept here so
-- this file still states the complete index set in one place.
--
-- department: the DOT/DOI/DOE/VA/HHS dropdown is an equality filter → btree.
create index if not exists opp_department_idx on public.opportunities (department);
-- state: equality filter for hand-entered rows (crawled rows resolve state
-- through sources.state instead).
create index if not exists opp_state_idx on public.opportunities (state);
-- partial: the "shared" view is a small slice, and false rows never need it.
create index if not exists opp_shared_idx on public.opportunities (is_shared) where is_shared;
-- the pipeline grid sorts newest-found first.
create index if not exists opp_date_found_idx on public.opportunities (date_found desc nulls last);
