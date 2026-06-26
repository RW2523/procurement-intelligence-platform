# AJACE — Procurement Intelligence & Response Automation

An end-to-end platform that **discovers** open government procurement opportunities daily from a
configurable list of portals, **stores them once** (deduped, no redundant crawling), **tracks their
lifecycle** (new → amended → closing → closed), **drafts AI responses** in two styles, and gives a team a
**review-and-edit workspace** to approve, revise, submit, and track every opportunity.

Three engines:

1. **The Hunter** — connector-per-portal crawlers, dedupe, and change detection.
2. **The Brain** — Postgres system-of-record + two-mode AI drafting with RAG.
3. **The Cockpit** — the web app: dashboard, review/edit workspace, status board, sources, analytics.

---

## 🚀 Live deployment (entirely in the cloud)

- **App:** https://pocu-wheat.vercel.app — gated by Basic Auth (any username, password `ajace-demo`)
- **Vercel** runs the Next.js app, API routes, and the serverless crawlers; **Vercel Cron** hits
  `/api/cron` daily at 10:00 UTC (~6 AM ET, protected by `CRON_SECRET`).
- **Supabase** (cloud) holds the Postgres + `pgvector` data; **OpenRouter** serves the LLM.
- Nothing runs locally — the whole pipeline (discover → dedupe → draft → review → track) lives in the cloud.

> Demo posture: the public URL is protected only by a shared password, and the database currently uses
> the `anon` key with permissive RLS. For real production, set `SUPABASE_SERVICE_ROLE_KEY` to the
> service_role secret, drop the `demo_all` RLS policies, and add per-user auth.

Redeploy with `vercel --prod`. On serverless, MA uses its reliable httpx page (Playwright stays off
unless `PLAYWRIGHT_ENABLED=true`).

---

## Stack

| Layer | Choice |
|------|--------|
| App | Next.js 16 (App Router) + React 19 + TypeScript |
| Styling | Tailwind v4 design system |
| Database | Supabase Postgres + `pgvector` (system of record + embeddings) |
| Crawling | tiered: JSON API → `httpx`/`cheerio` → Playwright fallback, one adapter per portal |
| AI | OpenRouter gateway (model in config) + deterministic mock fallback; local RAG embeddings |
| Export | Word `.docx` (submission-ready) |

---

## The five live connectors

Each portal is technically different, so each gets its own adapter behind one interface
(`Connector.fetchOpenOpportunities() → NormalizedOpportunity[]`). All five are **verified live**:

| State | Portal | Tier | How it actually works |
|-------|--------|------|------------------------|
| **NC** | eVP | JSON API | Power Pages/Dataverse `entity-grid-data.json` — seed cookies + anti-forgery token, POST paged JSON. |
| **TN** | CPO | Static HTML | Two tables (RFP + ITB); `cheerio`; detail = solicitation PDF. |
| **AR** | OSP | Static HTML | Two tables keyed off the bid-number anchor's cell offset. |
| **PA** | eMarketplace | ASP.NET ViewState | Seed the WebForm, replay the full form with `ddlRows=ALL` → all open solicitations in one POST. |
| **MA** | COMMBUYS | JSF (PrimeFaces) | Page 1 via `httpx`; deeper pages via Playwright paginator. |

Each connector was derived from live reconnaissance against the real portals (raw recon artifacts are
generated locally under `/recon`, which is gitignored). Every connector is verified pulling real data via
`GET /api/connectors/<slug>/preview`.

---

## Setup

The Supabase project (schema + `pgvector` + the 5 seeded sources + demo users) is **already provisioned**.
You only need to supply two secrets in `.env.local`:

```bash
# Already filled in:
NEXT_PUBLIC_SUPABASE_URL=https://coaszrosqlhifcwxurwu.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_...

# You add these:
SUPABASE_SERVICE_ROLE_KEY=...   # Supabase dashboard → Project Settings → API → service_role secret
OPENROUTER_API_KEY=sk-or-...    # https://openrouter.ai/keys  (optional — blank = deterministic mock drafts)
```

> The server uses the **service_role** key (RLS is enabled on every table; the key never reaches the browser).
> With no `OPENROUTER_API_KEY`, AI drafting still works via a deterministic mock engine (drafts are tagged
> `model_used = mock-engine`); drop in a key later to switch to a live model — one config change.

```bash
npm install
npx playwright install chromium   # for MA deep pagination
npm run dev                       # http://localhost:3000
```

---

## Using it

- **Run a crawl:** click *Run all crawls* in the UI, or `npm run crawl` (one source: `npm run crawl nc`).
- **Daily schedule:** `vercel.json` wires `/api/cron` to 10:00 UTC (~6 AM ET). Any scheduler can hit
  `POST /api/cron` (optionally guarded by `CRON_SECRET`).
- **Smoke-test a connector (no DB):** `GET /api/connectors/<slug>/preview?limit=5`.

### Screens
- **Dashboard** — open / new / closing-soon / amended counts, new-since-last-crawl, deadlines, portal health.
- **Opportunities** — filterable deduped master list with status + relevance.
- **Opportunity detail** — description, attachments, version history, full audit trail, and the **Response Workspace**.
- **Response Workspace** — Mode 1 (style-matched, RAG) + Mode 2 (LLM-original) side by side, edit, the
  revision loop ("tell it what to change"), revision history, approve/submit, and **Word export**.
- **Pipeline Board** — Kanban (Backlog → … → Won/Lost); drag or dropdown; every move logged.
- **Sources** — per-portal health, schedules, *Run now*, *Add portal* (registers + schedules new portals).
- **Knowledge Library** — upload past proposals → chunked + embedded for RAG.
- **Analytics** — pipeline by stage, AI mode usage, coverage by state, win rate, crawl health.
- **Notifications** — new opportunities, amendments, deadline/Q&A reminders, crawl failures.

---

## How "no redundancy" works (the daily pipeline)

`fetch → normalize → match on (source_id, external_id) → decide`:

| Situation | Action |
|-----------|--------|
| New | Insert, version 1, attachments, relevance score, notify if relevant. |
| Seen, hash unchanged | Touch `last_seen_at` only — **no reprocessing**. |
| Seen, hash changed | New version, mark **AMENDED**, notify (draft may be stale). |
| Gone + past due | **CLOSED**. |
| Gone + not past due | **REMOVED**. |

A unique constraint on `(source_id, external_id)` is the anti-duplicate guarantee at the DB level; a
`content_hash` of the meaningful fields is the change-detection key.

---

## Project map

```
src/lib/connectors/   one adapter per portal + shared http (cookie jar) / parse helpers + registry
src/lib/crawl/        pipeline (dedupe/change/reconcile), runner, content hashing
src/lib/ai/           OpenRouter client, embeddings, RAG, two-mode generate + revision, relevance
src/lib/db/           query layer (opportunities, sources, responses, dashboard, analytics, …)
src/lib/notify/       deadline & Q&A reminder scanner
src/app/              App Router pages + API routes + server actions
src/components/       UI kit, layout shell, and feature components
supabase migrations   core_schema + seed (applied)
```

Deploy to Vercel; the cron entry handles the daily crawl. Connectors break when portals redesign — the
Sources health view + crawl-failure notifications surface that quickly.
