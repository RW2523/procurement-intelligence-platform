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

export const dbConfigured = !!process.env.DATABASE_URL;
