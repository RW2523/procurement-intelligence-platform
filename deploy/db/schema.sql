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
-- Idempotent: safe to re-run on every deploy (install.sh does exactly that).
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
  pipeline_stage       text not null default 'BACKLOG'
                       check (pipeline_stage in ('BACKLOG','REVIEWING','DRAFTING','APPROVED',
                                                 'SUBMITTED','WON','LOST','DECLINED')),
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
-- Grant access by inserting a row here with the role you want:
--   insert into public.users (name, email, role)
--   values ('Richard', 'richard@ajace.com', 'admin')
--   on conflict (email) do update set role = excluded.role;
create unique index if not exists users_email_lower_idx on public.users (lower(email));

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
