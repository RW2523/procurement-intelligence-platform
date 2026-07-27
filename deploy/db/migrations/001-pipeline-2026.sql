-- =============================================================================
-- 001-pipeline-2026 — Pipeline_2026 workbook support
--
-- WHAT THIS DOES
--   1. Adds the 18 hand-entry columns the user's real spreadsheet needs.
--   2. Replaces the 8-value pipeline_stage vocabulary with the agreed 11, and
--      remaps the retired values on existing rows.
--   3. Creates forecast_opportunities for the "Forecased Opportunities" sheet.
--
-- WHY THIS FILE EXISTS AT ALL
--   deploy/db/schema.sql declares everything inside `create table if not
--   exists`. On a database that already has `opportunities`, Postgres skips the
--   whole CREATE — so editing schema.sql has ZERO effect on the live RDS table.
--   schema.sql is the truth for a FRESH box; this file is the truth for the
--   EXISTING one. Both were changed together; keep them that way.
--
-- HOW TO RUN
--   You do not normally run this file directly. deploy/db/schema.sql
--   `\ir`-includes it at the bottom, and schema.sql is what the installer
--   applies, so:
--     npm run db:migrate           # psql -v ON_ERROR_STOP=1 -f deploy/db/schema.sql
--   applies the CREATEs and then this migration, in that order, on every deploy.
--   The box's installer (deploy/scripts/install.sh in ajace-timesheet-aws) runs
--   that same psql command, so a deploy picks this up with no manual step.
--   Running it standalone works, is idempotent, and — see PORTABILITY — no longer
--   requires psql specifically:
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f deploy/db/migrations/001-pipeline-2026.sql
--
-- PORTABILITY — THIS FILE IS PLAIN SQL. NO psql META-COMMANDS. DELIBERATE.
--   This file used to open with `\set ON_ERROR_STOP on`. That is a psql
--   META-COMMAND — psql eats it and the server never sees it — so ANY other
--   applier died on it before executing a single statement. Measured, applying
--   this file through node-pg as `client.query(readFileSync(f,'utf8'))` (this
--   repo already depends on `pg`, and the RDS console query editor and every
--   generic migration runner behave the same way):
--       NODE-PG: FAILED -> syntax error at or near "\"
--                at character 4896        <- exactly the \set line
--
--   CHOSEN FIX: make the file PORTABLE (delete the meta-command) rather than
--   harden the psql-only requirement. Why that direction:
--     * Nothing else in here needs psql. Every remaining line is standard
--       server-side SQL, so portability cost exactly one deleted line. Fencing
--       the file off from three usable appliers to keep that line is the worse
--       trade.
--     * ON_ERROR_STOP was never what made this file safe. Safety comes from the
--       single explicit BEGIN/COMMIT below: on any error the transaction enters
--       the aborted state, every later statement fails with "current transaction
--       is aborted", and the trailing COMMIT acts as ROLLBACK. No applier can
--       produce a half-migrated database, with or without the flag.
--     * What ON_ERROR_STOP actually buys is psql's non-zero EXIT CODE. That is a
--       property of the psql INVOCATION, not of the file, and both real callers
--       already pass it on the command line — `npm run db:migrate` and the box's
--       install.sh both use `psql -v ON_ERROR_STOP=1`. In the file it was
--       redundant where it worked and fatal everywhere else.
--     * It was also actively wrong inside an `\ir` include. `\set` is psql
--       SESSION state and is NOT reverted at COMMIT, so it leaked into the rest
--       of schema.sql's session — precisely the leak STEP 0 uses `set local` to
--       avoid — and it took effect too late to protect the statements schema.sql
--       had already run ABOVE the `\ir` line.
--   KEEP IT THIS WAY. If you need a psql-ism, put it in schema.sql (which is
--   psql-only by necessity — it uses `\ir`) or on the command line. Not here.
--   schema.sql itself stays psql-only and that is unchanged; THIS file is the one
--   that has to survive being applied by something else.
--
-- COLUMN ORDER — fresh install and migrated box are ALIGNED. Keep them that way.
--   ALTER TABLE ADD COLUMN can only APPEND, so on the existing box the 18
--   columns in STEP 1 land after `updated_at`. schema.sql used to declare the
--   same 18 mid-table (just before content_hash), so a fresh install and a
--   migrated box ended up with identical columns at DIFFERENT ordinal positions.
--   Nothing queried breaks — every insert in the tree names its columns — but
--   `select *` column order and pg_dump output differed between two boxes that
--   are supposed to be identical, which makes any future schema diff a false
--   positive. Fixed by MOVING the block in schema.sql to the end of the
--   opportunities CREATE rather than by documenting the divergence, since the
--   two orders can be made to agree for free (fresh installs only) and the
--   migrated box's order cannot be changed without rewriting the table.
--   THE 18 COLUMNS IN STEP 1 AND THE 18 AT THE END OF schema.sql's
--   opportunities CREATE MUST STAY IN THE SAME ORDER.
--
-- SAFETY PROPERTIES
--   * IDEMPOTENT, AND CHEAP ON RE-RUN. Every statement is `if not exists` /
--     `if exists` or explicitly guarded. In particular the pipeline_stage CHECK
--     is kept rather than dropped-and-re-added when it is already correct: a
--     re-add re-validates every row in `opportunities` under ACCESS EXCLUSIVE.
--     See STEP 2a.
--   * ATOMIC. One explicit BEGIN/COMMIT. DDL is transactional in Postgres, so a
--     failure anywhere rolls back the columns, the data remap AND the
--     constraint together — there is no half-migrated state to clean up.
--   * NON-DESTRUCTIVE. No column is dropped, no row is deleted, no existing
--     column changes type. Every added column is nullable or defaulted, so
--     existing rows and the currently-deployed app keep working unchanged.
--   * BOUNDED. It cannot stall the live app indefinitely — see LOCK SAFETY.
--
-- LOCK SAFETY — WHY THE TIMEOUTS BELOW ARE NOT OPTIONAL
--   Step 1's ALTER TABLE takes ACCESS EXCLUSIVE on public.opportunities and this
--   transaction holds it until COMMIT. That is fine once acquired — the DDL is
--   metadata-only and the scans are small — but ACQUIRING it is the hazard.
--   Postgres queues lock requests in arrival order, and a queued ACCESS
--   EXCLUSIVE blocks everything behind it. So if a crawler run or any app
--   request has an open transaction touching opportunities when this starts,
--   the sequence is: migration waits for that transaction, and every read and
--   write that arrives afterwards waits for the migration. One slow crawler
--   transaction becomes an app-wide outage on the busiest table, for as long as
--   it lasts — and nothing here would time out.
--   Measured on a scratch cluster without the timeouts: one session holding
--   `begin; select count(*) from opportunities; pg_sleep(20)` made an ordinary
--   `select count(*) from opportunities` — issued after the migration, and
--   needing no lock the migration conflicts with on its own — take 17.0s.
--   With lock_timeout the same run fails in 5s, rolls back, releases the queue,
--   and the app read returns immediately. FAILING IS THE CORRECT OUTCOME: the
--   migration is idempotent, so the fix is to re-run it once the database is
--   quiet. A failed deploy is recoverable; a frozen opportunities table is not.
--
--   Not solved with CREATE INDEX CONCURRENTLY: that cannot run inside a
--   transaction block, and this file's atomicity (columns + remap + constraint
--   land together or not at all) is worth more than a lock-free index build on
--   a table this size.
--
-- DEPLOY ORDER MATTERS — and the installer already gets it right.
--   install.sh applies schema.sql (and therefore this file) at step 5b, BEFORE
--   `npm run build` and before `pm2 startOrReload` at step 6, so the constraint
--   is widened while the OLD build is still the one serving. Do not reorder it.
--
--   Run this BEFORE deploying the new app build. src/app/actions.ts
--   setStageAction does no validation whatsoever — the raw string goes straight
--   into the UPDATE — so if the app ships first, the very first board drag onto
--   a new stage throws a bare Postgres constraint violation at the user.
--   Running this first is safe in the other direction: the old build only ever
--   writes values that are still legal, except that the old default 'BACKLOG'
--   is gone, which is exactly the point.
-- =============================================================================

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 0 — lock discipline. Read LOCK SAFETY in the header before changing
-- these numbers; they are what stops a deploy from freezing the application.
--
-- `set local` (not `set`) so they revert at COMMIT and do not leak into the
-- rest of the psql session — schema.sql `\ir`-includes this file, and the next
-- migration appended there must choose its own limits deliberately, not inherit
-- these by accident.
--
-- lock_timeout — the load-bearing one. Caps how long this transaction will WAIT
--   for a lock. Without it the wait is unbounded, and because a pending ACCESS
--   EXCLUSIVE blocks every request that arrives behind it, that wait is an
--   outage. 5s is longer than any healthy transaction on this table and short
--   enough that a stalled deploy is a blip. On timeout the server raises
--   "canceling statement due to lock timeout", which aborts the transaction —
--   so the rollback and the draining of the lock queue happen server-side and do
--   not depend on the applier. (psql -v ON_ERROR_STOP=1 additionally makes the
--   deploy EXIT non-zero rather than continuing; see PORTABILITY.)
--   Re-run when quiet; the file is idempotent.
-- statement_timeout — backstop for the other half: a lock ACQUIRED but held too
--   long. Every statement below is metadata-only DDL or a scan of a table in the
--   tens of thousands of rows, so 5min is orders of magnitude of headroom and is
--   only ever hit by something pathological. Raise it (do not delete it) if
--   opportunities ever grows enough to need more.
-- ─────────────────────────────────────────────────────────────────────────────
set local lock_timeout      = '5s';
set local statement_timeout = '5min';

-- The 11-value pipeline_stage vocabulary, named ONCE. Steps 2a, 2e and 2g read
-- it from here so the "is the constraint already correct?" test, the "are there
-- unmigrated rows?" test and the post-condition cannot drift apart. Step 2f
-- still spells the list out literally — ADD CONSTRAINT needs a literal
-- predicate, and the constraint text must be readable verbatim by whoever
-- reviews this before it is pointed at production — and step 2g fails the
-- migration if 2f's literal and this list ever disagree.
--
-- set_config(..., is_local => true) is the plain-SQL equivalent of `set local`:
-- transaction-scoped, reverted at COMMIT, and (unlike `\set`) actually executed
-- by the server, so it survives a non-psql applier. See PORTABILITY.
-- (wrapped in DO/perform rather than a bare `select set_config(...)` only so it
-- does not print a result row into the deploy log on every run.)
do $$
begin
  perform set_config(
    'pipeline_2026.stages',
    'IDENTIFIED,QUALIFYING,PURSUING,NO_BID,REVIEWING,APPROVED,SUBMITTED,ORALS,BAFO,WON,LOST',
    true);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1 — new columns on opportunities.
-- Additive and idempotent. Deliberately FIRST: it touches nothing the later
-- steps depend on, and it is the part most likely to be re-run on its own.
-- Rationale for each name/type lives in deploy/db/schema.sql beside the column;
-- the load-bearing ones are repeated here because this is what gets reviewed
-- before it is pointed at production.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.opportunities
  -- "Share/No Share" — sheet holds exactly Yes/No.
  add column if not exists is_shared             boolean not null default false,
  -- "Date found" — the human's discovery date. NOT first_seen_at: that is
  -- `default now()`, backs opp_first_seen_idx and IS the default list sort.
  add column if not exists date_found            date,
  -- Parent department. NO CHECK CONSTRAINT: the 5 priority departments
  -- (DOT/DOI/DOE/VA/HHS) are a filter + a scoring bonus, never a gate on what
  -- may be crawled. Assigned by the matcher in src/lib/departments.ts.
  add column if not exists department            text,
  -- Operating administration below `department` — the 'FAA' of "DOT/FAA".
  add column if not exists sub_agency            text,
  -- USPS code for hand-entered rows: the 'manual' source is seeded state = null,
  -- so those rows are invisible to the source-based state filter.
  add column if not exists state                 text,
  -- "Agency/POC" verbatim. Kept OUT of `agency`, which is trigram-indexed, is an
  -- ILIKE target of the free-text search, and is what the targeting engine
  -- matches agency aliases against.
  add column if not exists poc_raw               text,
  add column if not exists poc_name              text,
  add column if not exists poc_email             text,
  add column if not exists poc_phone             text,
  -- "RFx #" verbatim; the cleaned token goes to external_id.
  add column if not exists rfx_number_raw        text,
  -- text[] — cells carry multiple codes ("54151S & 518210C"). BIND RAW. MUST NOT
  -- be added to the JSONB map in src/lib/db/query.ts; JSON.stringify on a text[]
  -- yields "malformed array literal".
  add column if not exists naics_codes           text[] not null default '{}',
  add column if not exists period_of_performance text,
  -- "Estimated Value" verbatim ('1.96B BPA'). estimated_value (double precision)
  -- is KEPT and stays the numeric axis for summing and value-band scoring.
  add column if not exists estimated_value_text  text,
  -- Raw deadline cells. The typed timestamptz columns stay authoritative; these
  -- make a bad parse of '07/23/26  5 PM???' recoverable instead of silently
  -- wrong by 4-6 hours.
  add column if not exists q_and_a_deadline_text text,
  add column if not exists due_date_text         text,
  -- The sheet's "Status" column: a free-text capture log. *** NOT named `status`
  -- *** — that is the solicitation-lifecycle enum that ~15 call sites filter on.
  add column if not exists capture_notes         text,
  -- "Won/Loss". NO CHECK: real values include 'in evalution ' and 'RFI no
  -- response'. A separate axis from pipeline_stage; the two legitimately differ.
  add column if not exists outcome               text,
  add column if not exists lessons_learned       text;

create index if not exists opp_department_idx on public.opportunities (department);
create index if not exists opp_state_idx      on public.opportunities (state);
create index if not exists opp_shared_idx     on public.opportunities (is_shared) where is_shared;
create index if not exists opp_date_found_idx on public.opportunities (date_found desc nulls last);

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2 — pipeline_stage vocabulary swap.
--
-- ORDER IS LOAD-BEARING AND BOTH WRONG ORDERS FAIL:
--   remap first  → the UPDATE writes 'IDENTIFIED', the OLD check rejects it.
--   constrain first → the ADD CONSTRAINT scans rows still holding 'BACKLOG'
--                     and is rejected.
-- So: get the old constraint out of the way, remap with NO constraint in force,
-- move the default, then add the new constraint last.
--
-- The ONE exception, and the reason 2a is not a plain DROP: if the new
-- constraint is ALREADY in force and validated, none of that is needed — a
-- validated CHECK is Postgres' own proof that every row already satisfies it.
-- In that case 2a keeps it and 2e/2f are skipped, which is what stops a re-run
-- from re-validating the whole table under ACCESS EXCLUSIVE on every deploy.
-- 2b/2c/2d still run unconditionally: 2b is served by opp_pipeline_stage_idx and
-- matches nothing (0.065 ms measured), 2c reads a different table that the
-- constraint says nothing about, and 2d is metadata-only. Only 2e and 2f are
-- expensive, and only they are guarded.
-- ─────────────────────────────────────────────────────────────────────────────

-- 2a. Reconcile the CHECK: KEEP it if it is already exactly right, otherwise
--     drop it so steps 2b-2f can rebuild it. Constraints are discovered from the
--     catalogue rather than assumed: `opportunities_pipeline_stage_check` is an
--     auto-generated name, and a hand-applied schema or an earlier partial run
--     may have left another.
--
--     WHY "KEEP", NOT "ALWAYS DROP AND RE-ADD". Dropping is metadata-only and
--     free, but the matching ADD CONSTRAINT in 2f is NOT: Postgres validates the
--     predicate against EVERY EXISTING ROW, holding ACCESS EXCLUSIVE on
--     `opportunities` for the whole scan — which, per the LOCK SAFETY note in
--     the header, also blocks every app read and write that queues behind it.
--     Unconditional drop+re-add is idempotent in RESULT but pays that full scan
--     on every single re-run, forever, to arrive at the constraint it already
--     had. Measured on a scratch cluster, 200,000 rows / 172 MB:
--         alter table ... drop constraint ...   0.363 ms   (metadata only)
--         alter table ... add  constraint ...  44.195 ms   (full validation scan)
--     and it grows with the table. schema.sql is re-applied on EVERY deploy, so
--     that is a per-deploy cost, not a one-off.
--
--     "Already right" is decided on MEANING, not on the definition string:
--     pg_get_constraintdef normalises `x in (...)` to `x = ANY (ARRAY[...])`, so
--     a text compare against what we wrote in 2f would never match and the
--     constraint would be rebuilt every run anyway. Instead we pull the quoted
--     literals out of the rendered definition and compare them as a SET against
--     pipeline_2026.stages. Safe here because no stage value contains a quote.
--     convalidated is required too: a NOT VALID constraint enforces new writes
--     but proves nothing about existing rows, so it must be rebuilt.
do $$
declare
  want text[] := (select array_agg(w order by w)
                    from unnest(string_to_array(current_setting('pipeline_2026.stages'), ',')) w);
  have text[];
  c    record;
  kept boolean := false;
begin
  for c in
    select conname, oid, convalidated, pg_get_constraintdef(oid) as def
      from pg_constraint
     where conrelid = 'public.opportunities'::regclass
       and contype  = 'c'
       and pg_get_constraintdef(oid) like '%pipeline_stage%'
     order by conname
  loop
    select array_agg(m[1] order by m[1])
      into have
      from regexp_matches(c.def, '''([^'']*)''', 'g') m;

    if not kept
       and c.conname = 'opportunities_pipeline_stage_check'
       and c.convalidated
       and have is not distinct from want
    then
      kept := true;
      raise notice
        'pipeline_stage CHECK % is already correct — keeping it (no revalidation scan)', c.conname;
    else
      -- Wrong vocabulary, NOT VALID, or a duplicate under another name.
      execute format('alter table public.opportunities drop constraint %I', c.conname);
      raise notice 'dropped check constraint %', c.conname;
    end if;
  end loop;

  -- Hand the decision to 2e and 2f. Transaction-local, same as STEP 0.
  perform set_config('pipeline_2026.stage_check_ok', kept::text, true);
end $$;

-- 2b. Remap the retired values. Idempotent: on a re-run the WHEREs match zero
--     rows. REVIEWING / APPROVED / SUBMITTED / WON / LOST carry over unchanged.
update public.opportunities set pipeline_stage = 'IDENTIFIED' where pipeline_stage = 'BACKLOG';
update public.opportunities set pipeline_stage = 'PURSUING'   where pipeline_stage = 'DRAFTING';
update public.opportunities set pipeline_stage = 'NO_BID'     where pipeline_stage = 'DECLINED';

-- 2c. The audit trail. opportunity_status_log.old_value / new_value are FREE
--     TEXT with no constraint, so they would keep displaying 'BACKLOG' and
--     'DRAFTING' on the detail page forever. `field` is CHECK-constrained to
--     ('status','pipeline_stage') and constrains the FIELD NAME only — so scope
--     these updates to field = 'pipeline_stage' or they would also rewrite rows
--     belonging to the solicitation-status axis.
--     (src/lib/status.ts pipelineLabel() also maps these three defensively, for
--     any row written between this migration and the app deploy.)
update public.opportunity_status_log
   set old_value = case old_value
                     when 'BACKLOG'  then 'IDENTIFIED'
                     when 'DRAFTING' then 'PURSUING'
                     when 'DECLINED' then 'NO_BID'
                     else old_value end,
       new_value = case new_value
                     when 'BACKLOG'  then 'IDENTIFIED'
                     when 'DRAFTING' then 'PURSUING'
                     when 'DECLINED' then 'NO_BID'
                     else new_value end
 where field = 'pipeline_stage'
   and (old_value in ('BACKLOG','DRAFTING','DECLINED')
     or new_value in ('BACKLOG','DRAFTING','DECLINED'));

-- 2d. Move the default. Without this every newly crawled row keeps landing in
--     'BACKLOG' — which step 2f is about to make illegal, i.e. the next crawl
--     would fail on insert. Unconditional: it is metadata-only, and a correct
--     CHECK does NOT imply a correct default (a CHECK is validated against
--     existing ROWS, never against the column default), so 2a's decision must
--     not be allowed to skip it.
alter table public.opportunities alter column pipeline_stage set default 'IDENTIFIED';

-- 2e. Fail loudly BEFORE the constraint, so the operator sees the offending
--     values instead of a bare "violates check constraint". Rolls the whole
--     transaction back, same as the constraint would.
--     SKIPPED when 2a kept the constraint: a VALIDATED CHECK over this exact
--     predicate is already Postgres' proof that no such row exists, so the scan
--     could only ever return nothing. It is a seq scan (a negated IN cannot use
--     opp_pipeline_stage_idx) — 30.6 ms / 21,959 buffers on the 200k-row scratch
--     table — so skipping it is most of what makes a re-run cheap.
do $$
declare bad text;
begin
  if coalesce(current_setting('pipeline_2026.stage_check_ok', true), 'false')::boolean then
    return;
  end if;

  select string_agg(distinct pipeline_stage, ', ')
    into bad
    from public.opportunities
   where pipeline_stage not in ('IDENTIFIED','QUALIFYING','PURSUING','NO_BID','REVIEWING',
                                'APPROVED','SUBMITTED','ORALS','BAFO','WON','LOST');
  if bad is not null then
    raise exception
      'unmigrated pipeline_stage value(s) present: %. Add a remap above before re-running.', bad;
  end if;
end $$;

-- 2f. The new vocabulary. Order matches src/lib/types.ts PIPELINE_STAGES.
--     `status` (NEW/OPEN/…/AWARDED/CANCELLED) is a DIFFERENT AXIS and is left
--     completely alone: AWARDED there means the agency awarded to SOMEONE,
--     possibly a competitor, and renaming it WON would claim wins we did not have.
--
--     Guarded by 2a's decision: this is the statement that takes ACCESS
--     EXCLUSIVE and validates every row, so it must not run when the identical
--     constraint is already in place. Postgres has no
--     `add constraint if not exists`, which is why the test lives in 2a and the
--     answer is carried here rather than expressed inline.
--     If you change the list below, change pipeline_2026.stages in STEP 0 to
--     match — 2g turns a mismatch into a hard failure.
do $$
begin
  if coalesce(current_setting('pipeline_2026.stage_check_ok', true), 'false')::boolean then
    return;
  end if;

  alter table public.opportunities
    add constraint opportunities_pipeline_stage_check
    check (pipeline_stage in ('IDENTIFIED','QUALIFYING','PURSUING','NO_BID','REVIEWING',
                              'APPROVED','SUBMITTED','ORALS','BAFO','WON','LOST'));
end $$;

-- 2g. Post-condition. Asserts the constraint that is now in force matches
--     pipeline_2026.stages, whichever path got us here.
--     This is what keeps the 2a optimisation honest. Without it, editing 2f's
--     literal list and forgetting STEP 0 would make 2a judge the constraint
--     "wrong" on every future run and silently reinstate the per-deploy
--     revalidation scan this step exists to avoid — a performance regression
--     with no error message. Now it fails the deploy instead. Pure catalogue
--     lookup: no table access, no lock.
do $$
declare
  want text[] := (select array_agg(w order by w)
                    from unnest(string_to_array(current_setting('pipeline_2026.stages'), ',')) w);
  have text[];
begin
  select array_agg(m[1] order by m[1])
    into have
    from pg_constraint c,
         lateral regexp_matches(pg_get_constraintdef(c.oid), '''([^'']*)''', 'g') m
   where c.conrelid    = 'public.opportunities'::regclass
     and c.contype     = 'c'
     and c.conname     = 'opportunities_pipeline_stage_check'
     and c.convalidated;

  if have is distinct from want then
    raise exception
      'pipeline_stage CHECK does not match pipeline_2026.stages (constraint has %, expected %). '
      'STEP 0 and step 2f have drifted apart; make them agree.', have, want;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 3 — forecast_opportunities.
-- Its own table, not a flag on `opportunities`: a forecast row has no
-- solicitation number, no source, no due date, no status and no stage, and all
-- of source_id / external_id / status / pipeline_stage / content_hash are NOT
-- NULL over there. Declared after step 1 because of the FK to opportunities.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.forecast_opportunities (
  id                          uuid primary key default gen_random_uuid(),
  date_found                  date,   -- sheet "Date Found"
  department                  text,   -- sheet "Agency"       e.g. 'DOT'
  sub_agency                  text,   -- sheet "Organization" e.g. 'FMCSA','FAA'
  title                       text not null,
  detail_url                  text,   -- sheet "Link to details"; trim() on import
  estimated_solicitation_date date,
  -- text[] — bind RAW, never JSON.stringify. Keep OUT of the query.ts JSONB map.
  set_asides                  text[] not null default '{}',
  notes                       text,
  promoted_opportunity_id     uuid references public.opportunities(id) on delete set null,
  created_by                  uuid references public.users(id) on delete set null,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);
create index if not exists forecast_solicitation_idx
  on public.forecast_opportunities (estimated_solicitation_date asc nulls last);
create index if not exists forecast_department_idx
  on public.forecast_opportunities (department);
-- import idempotency key; partial because detail_url is nullable and several
-- NULLs must remain legal.
create unique index if not exists forecast_url_key
  on public.forecast_opportunities (detail_url) where detail_url is not null;

commit;

-- ─────────────────────────────────────────────────────────────────────────────
-- POST-CHECK (read-only; safe to paste separately)
--   select pipeline_stage, count(*) from public.opportunities group by 1 order by 2 desc;
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.opportunities'::regclass and conname like '%pipeline_stage%';
--   select column_default from information_schema.columns
--    where table_name = 'opportunities' and column_name = 'pipeline_stage';  -- 'IDENTIFIED'
-- Expect: no BACKLOG / DRAFTING / DECLINED rows, an 11-value CHECK, and the
-- default reading 'IDENTIFIED'::text.
--
-- READING THE DEPLOY LOG. Step 2a prints exactly one of two notices, and which
-- one tells you what this run did:
--   "dropped check constraint opportunities_pipeline_stage_check"
--       -> the constraint was wrong/absent/NOT VALID; 2e and 2f ran, and 2f
--          revalidated the whole table under ACCESS EXCLUSIVE. Expected on the
--          FIRST application to a box, and only then.
--   "pipeline_stage CHECK ... is already correct — keeping it (no revalidation
--    scan)"
--       -> nothing to do. Expected on EVERY subsequent deploy, including the
--          first deploy of a FRESH box (schema.sql's CREATE TABLE already
--          declares the 11-value CHECK, so the migration finds it correct).
-- Seeing "dropped check constraint" on consecutive deploys of an unchanged box
-- means 2a is failing to recognise its own constraint — that is a bug in the
-- comparison, not a no-op, and it is costing a full validation scan per deploy.
-- ─────────────────────────────────────────────────────────────────────────────
