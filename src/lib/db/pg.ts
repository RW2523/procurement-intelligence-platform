import "server-only";
import { Pool } from "pg";

/**
 * Amazon RDS Postgres connection pool.
 *
 * Replaces the Supabase service-role client. Procurement never queried from the
 * browser — every call site is a server action, route handler or lib function —
 * so there is no HTTP data endpoint here and no per-request scoping: the
 * authorization gate is, and always was, src/lib/auth/guard.ts.
 */
let _pool: Pool | null = null;

export function pool(): Pool {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // RDS presents an AWS-CA certificate; PGSSL=disable is for local Postgres.
      ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
      // Two apps share one db.t4g.micro (~110 connections). Keep this small.
      max: Number(process.env.PG_POOL_MAX || 4),
      idleTimeoutMillis: 30_000,
    });
  }
  return _pool;
}

export async function sql<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool().query(text, params);
  return res.rows as T[];
}

/**
 * A query function bound to one connection — same call shape as `sql`, so any
 * helper can take one and work either standalone or inside a transaction.
 */
export type Query = <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;

/**
 * Run `fn` inside a single BEGIN/COMMIT on one pooled connection. Commits when
 * it returns, ROLLBACKs and rethrows when it throws.
 *
 * This exists because `sql()` checks out a *different* connection per call, and
 * pg autocommits each statement: two related writes issued through `sql()` are
 * two independent transactions, so the first can land permanently while the
 * second fails. That is exactly wrong for a privilege change and its audit row
 * (src/lib/db/access.ts) — the change would be applied, unlogged, while the
 * caller is told it failed.
 *
 * TWO RULES inside `fn`:
 *   1. Use the supplied `q`, never the module-level `sql()`. `sql()` runs on a
 *      different connection: its writes are NOT covered by this transaction and,
 *      with PG_POOL_MAX connections all held by transactions, waiting on a
 *      second one can deadlock.
 *   2. A failed statement poisons the whole transaction ("current transaction is
 *      aborted"), so a try/catch around an optional query does NOT make it
 *      optional. Do those reads before the transaction — see findLogin().
 */
export async function transaction<T>(fn: (q: Query) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  const q: Query = async <R = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    (await client.query(text, params)).rows as R[];
  try {
    await client.query("begin");
    const out = await fn(q);
    await client.query("commit");
    return out;
  } catch (err) {
    // Best-effort: if the connection itself died the rollback throws too, and
    // reporting that instead of the real cause would bury the actual failure.
    try {
      await client.query("rollback");
    } catch {
      /* ignore — the original error below is the one that matters */
    }
    throw err;
  } finally {
    client.release();
  }
}

export const dbConfigured = !!process.env.DATABASE_URL;
