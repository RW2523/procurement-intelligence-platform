import "server-only";
import { sql } from "./pg";
import { storage } from "./s3";

/**
 * A Supabase-compatible query builder that compiles to SQL.
 *
 * WHY: the app has ~130 `.from(...)` call sites written against the Supabase
 * client. Rewriting each one by hand would be 130 chances to introduce a subtle
 * data bug in a system that decides which bids get pursued. Instead this
 * reproduces the slice of the PostgREST surface the app actually uses, so the
 * call sites keep working unchanged and the risk lives in ONE reviewed file.
 *
 * SAFETY: every value is bound as a parameter — never interpolated. Identifiers
 * (tables, columns) are validated against a strict pattern and quoted, so a
 * caller cannot smuggle SQL through a column name. This matters because the
 * opportunity search passes user input into filters: PostgREST used to make
 * that safe for us, and after the port it is our job.
 */

const IDENT = /^[a-z_][a-z0-9_]*$/;
const q = (id: string) => {
  if (!IDENT.test(id)) throw new Error(`unsafe identifier: ${id}`);
  return `"${id}"`;
};

/** Foreign keys the app embeds. Both the PostgREST `alias:table!fk(cols)` form
 *  and the plain `alias:table(cols)` form resolve through here. */
type Rel = { table: string; localKey: string; foreignKey: string; many: boolean };
const RELATIONS: Record<string, Record<string, Rel>> = {
  opportunities: {
    source:   { table: "sources", localKey: "source_id",   foreignKey: "id", many: false },
    assignee: { table: "users",   localKey: "assigned_to", foreignKey: "id", many: false },
    // reverse (one-to-many) — used as `responses(count)` etc.
    responses:            { table: "responses",            localKey: "id", foreignKey: "opportunity_id", many: true },
    attachments:          { table: "attachments",          localKey: "id", foreignKey: "opportunity_id", many: true },
    opportunity_versions: { table: "opportunity_versions", localKey: "id", foreignKey: "opportunity_id", many: true },
  },
  attachments: {
    source: { table: "sources", localKey: "source_id", foreignKey: "id", many: false },
  },
  company_knowledge: {
    company_knowledge_chunks: {
      table: "company_knowledge_chunks", localKey: "id", foreignKey: "knowledge_id", many: true,
    },
  },
};


/**
 * jsonb columns, which MUST be JSON.stringify'd before binding.
 *
 * node-pg encodes a JS object/array as a Postgres composite/array literal, which
 * jsonb then rejects with "invalid input syntax for type json" — so every insert
 * carrying one silently fails. This is not hypothetical: the first real crawl
 * found 18 Texas/Mississippi opportunities and lost ALL of them to exactly this.
 *
 * The ARRAY columns below are the mirror image: they are text[], not jsonb, so
 * they must stay RAW JS arrays. Stringifying them produces
 * "malformed array literal". The two cases look identical in JS and must not be
 * conflated — hence an explicit list rather than a type guess.
 */
const JSONB: Record<string, Set<string>> = {
  opportunities:              new Set(["score_breakdown"]),
  opportunity_versions:       new Set(["snapshot_json"]),
  app_settings:               new Set(["value"]),
  targeting_profile_versions: new Set(["profile"]),
};
// text[] — bind RAW, and DELIBERATELY ABSENT from the map above:
//   company_knowledge.tags
//   opportunities.set_asides
//   opportunities.naics_codes                (added 2026-07, Pipeline_2026)
//   forecast_opportunities.set_asides        (added 2026-07, Pipeline_2026)
// The Pipeline_2026 change added NO jsonb column, so the JSONB map is unchanged.
// If you ever add one (a structured capture log, a POC object), it goes above.

const encode = (table: string, col: string, v: unknown) =>
  JSONB[table]?.has(col) && v !== null && v !== undefined ? JSON.stringify(v) : v;

type Filter = { col: string; op: string; val: unknown; negate?: boolean };
type Order = { col: string; ascending: boolean; nullsFirst?: boolean };

type Err = { message: string } | null;
// Two shapes, because the call sites need different ones: a list result must be
// any[] (so `.map(r => …)` gives r an EXPLICIT any and passes noImplicitAny),
// while .single()/.maybeSingle() must be a plain object.
type Result = { data: any; error: Err; count?: number | null };
type OneResult = { data: any; error: Err };

/** Splits a select list on commas that are NOT inside parentheses. */
function splitTop(sel: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of sel) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

class Builder implements PromiseLike<{ data: any[]; error: Err; count?: number | null }> {
  private op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private selectList = "*";
  private values: any = undefined;
  private filters: Filter[] = [];
  private orders: Order[] = [];
  private limitN: number | null = null;
  private offsetN = 0;
  private wantSingle = false;
  private allowNoRow = false;
  private wantCount = false;
  private headOnly = false;
  private onConflictCols: string | null = null;

  constructor(private table: string) {}

  select(list = "*", opts?: { count?: string; head?: boolean }) {
    if (this.op === "select") this.selectList = list || "*";
    if (opts?.count) this.wantCount = true;
    if (opts?.head) this.headOnly = true;
    return this;
  }
  insert(values: any) { this.op = "insert"; this.values = values; return this; }
  update(values: any) { this.op = "update"; this.values = values; return this; }
  delete() { this.op = "delete"; return this; }
  upsert(values: any, opts?: { onConflict?: string }) {
    this.op = "upsert"; this.values = values;
    this.onConflictCols = opts?.onConflict ?? "id";
    return this;
  }

  eq(col: string, val: unknown)   { this.filters.push({ col, op: "eq", val }); return this; }
  neq(col: string, val: unknown)  { this.filters.push({ col, op: "neq", val }); return this; }
  gt(col: string, val: unknown)   { this.filters.push({ col, op: "gt", val }); return this; }
  gte(col: string, val: unknown)  { this.filters.push({ col, op: "gte", val }); return this; }
  lt(col: string, val: unknown)   { this.filters.push({ col, op: "lt", val }); return this; }
  lte(col: string, val: unknown)  { this.filters.push({ col, op: "lte", val }); return this; }
  like(col: string, val: string)  { this.filters.push({ col, op: "like", val }); return this; }
  ilike(col: string, val: string) { this.filters.push({ col, op: "ilike", val }); return this; }
  in(col: string, vals: unknown[]) { this.filters.push({ col, op: "in", val: vals }); return this; }
  is(col: string, val: unknown)   { this.filters.push({ col, op: "is", val }); return this; }
  contains(col: string, val: unknown) { this.filters.push({ col, op: "contains", val }); return this; }
  /** PostgREST `.not(col, op, val)` — negates any of the above. */
  not(col: string, op: string, val: unknown) {
    this.filters.push({ col, op: op === "in" ? "in" : op, val, negate: true });
    return this;
  }
  /** `.or("a.ilike.%x%,b.ilike.%x%")` — an OR group over simple predicates. */
  or(expr: string) { this.filters.push({ col: "", op: "or", val: expr }); return this; }

  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) {
    // Supabase applies multiple .order() calls in sequence — keep them all.
    this.orders.push({ col, ascending: opts?.ascending !== false, nullsFirst: opts?.nullsFirst });
    return this;
  }
  limit(n: number) { this.limitN = n; return this; }
  range(from: number, to: number) { this.offsetN = from; this.limitN = to - from + 1; return this; }
  single(): PromiseLike<OneResult> { this.wantSingle = true; return this as unknown as PromiseLike<OneResult>; }
  maybeSingle(): PromiseLike<OneResult> {
    this.wantSingle = true; this.allowNoRow = true;
    return this as unknown as PromiseLike<OneResult>;
  }

  // ---------------------------------------------------------------- compile
  private buildSelectList(p: unknown[]): string {
    if (this.selectList.trim() === "*") return "*";
    const parts: string[] = [];
    for (const item of splitTop(this.selectList)) {
      const embed = item.match(/^(?:([a-z_]+)\s*:\s*)?([a-z_]+)(?:!([a-z_]+))?\s*\(([^)]*)\)$/i);
      if (!embed) { parts.push(item === "*" ? "*" : q(item)); continue; }

      const [, aliasRaw, relName, , innerRaw] = embed;
      const alias = aliasRaw || relName;
      const rel = RELATIONS[this.table]?.[alias] ?? RELATIONS[this.table]?.[relName];
      if (!rel) throw new Error(`no relationship "${alias}" on ${this.table}`);
      const inner = innerRaw.trim();
      const join = `${q(rel.table)}.${q(rel.foreignKey)} = ${q(this.table)}.${q(rel.localKey)}`;

      if (inner === "count") {
        // PostgREST returns [{ count: n }] for an aggregate embed.
        parts.push(
          `(select json_build_array(json_build_object('count', count(*)))
              from ${q(rel.table)} where ${join}) as ${q(alias)}`);
      } else if (rel.many) {
        parts.push(
          `(select coalesce(json_agg(row_to_json(e)), '[]'::json) from
              (select ${inner.split(",").map((c) => q(c.trim())).join(", ")}
                 from ${q(rel.table)} where ${join}) e) as ${q(alias)}`);
      } else {
        parts.push(
          `(select row_to_json(e) from
              (select ${inner.split(",").map((c) => q(c.trim())).join(", ")}
                 from ${q(rel.table)} where ${join}) e) as ${q(alias)}`);
      }
    }
    return parts.join(", ");
  }

  private buildWhere(p: unknown[]): string {
    const clauses: string[] = [];
    for (const f of this.filters) {
      if (f.op === "or") {
        // "col.ilike.%x%,col2.eq.y" -> (col ilike $1 or col2 = $2)
        const alts = String(f.val).split(",").map((piece) => {
          const m = piece.match(/^([a-z_]+)\.([a-z]+)\.(.*)$/i);
          if (!m) throw new Error(`unsupported or() term: ${piece}`);
          const [, col, op, raw] = m;
          const OPS: Record<string, string> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "like", ilike: "ilike" };
          if (!OPS[op]) throw new Error(`unsupported or() operator: ${op}`);
          p.push(raw);
          return `${q(col)} ${OPS[op]} $${p.length}`;
        });
        clauses.push(`(${alts.join(" or ")})`);
        continue;
      }
      const col = q(f.col);
      let c: string;
      switch (f.op) {
        case "eq":  p.push(f.val); c = `${col} = $${p.length}`; break;
        case "neq": p.push(f.val); c = `${col} <> $${p.length}`; break;
        case "gt":  p.push(f.val); c = `${col} > $${p.length}`; break;
        case "gte": p.push(f.val); c = `${col} >= $${p.length}`; break;
        case "lt":  p.push(f.val); c = `${col} < $${p.length}`; break;
        case "lte": p.push(f.val); c = `${col} <= $${p.length}`; break;
        case "like":  p.push(f.val); c = `${col} like $${p.length}`; break;
        case "ilike": p.push(f.val); c = `${col} ilike $${p.length}`; break;
        case "contains": p.push(f.val); c = `${col} @> $${p.length}`; break;
        case "in": {
          const arr = Array.isArray(f.val) ? f.val : String(f.val).replace(/^\(|\)$/g, "").split(",");
          if (!arr.length) { c = "false"; break; }
          p.push(arr); c = `${col} = any($${p.length})`;
          break;
        }
        case "is":
          c = f.val === null ? `${col} is null` : (p.push(f.val), `${col} is not distinct from $${p.length}`);
          break;
        default: throw new Error(`unsupported filter: ${f.op}`);
      }
      clauses.push(f.negate ? `not (${c})` : c);
    }
    return clauses.length ? ` where ${clauses.join(" and ")}` : "";
  }

  private buildOrderLimit(): string {
    let s = "";
    if (this.orders.length) {
      s += " order by " + this.orders.map((o) => {
        const dir = o.ascending ? "asc" : "desc";
        const nulls = o.nullsFirst === undefined ? "" : o.nullsFirst ? " nulls first" : " nulls last";
        return `${q(o.col)} ${dir}${nulls}`;
      }).join(", ");
    }
    if (this.limitN != null) s += ` limit ${Number(this.limitN)}`;
    if (this.offsetN) s += ` offset ${Number(this.offsetN)}`;
    return s;
  }

  private rowsToColumns(rows: any[]) {
    const cols = Array.from(rows.reduce((set: Set<string>, r) => {
      Object.keys(r).forEach((k) => set.add(k)); return set;
    }, new Set<string>()));
    return cols;
  }

  private async run(): Promise<Result> {
    const p: unknown[] = [];
    try {
      let text: string;
      let rows: any[];

      if (this.op === "select") {
        if (this.headOnly || this.wantCount) {
          const where = this.buildWhere(p);
          const c = await sql<{ n: string }>(`select count(*)::int as n from ${q(this.table)}${where}`, p);
          const n = Number(c[0]?.n ?? 0);
          if (this.headOnly) return { data: null, error: null, count: n };
          // count + rows: re-run for the rows
          const p2: unknown[] = [];
          const list = this.buildSelectList(p2);
          const w2 = this.buildWhere(p2);
          rows = await sql(`select ${list} from ${q(this.table)}${w2}${this.buildOrderLimit()}`, p2);
          return { data: rows, error: null, count: n };
        }
        const list = this.buildSelectList(p);
        text = `select ${list} from ${q(this.table)}${this.buildWhere(p)}${this.buildOrderLimit()}`;
        rows = await sql(text, p);
      } else if (this.op === "insert" || this.op === "upsert") {
        const list = Array.isArray(this.values) ? this.values : [this.values];
        if (!list.length) return { data: [], error: null };
        const cols = this.rowsToColumns(list);
        const tuples = list.map((row) =>
          "(" + cols.map((c) => { p.push(encode(this.table, c, row[c] ?? null)); return `$${p.length}`; }).join(", ") + ")");
        let conflict = "";
        if (this.op === "upsert") {
          const keys = (this.onConflictCols || "id").split(",").map((s) => s.trim());
          const setCols = cols.filter((c) => !keys.includes(c));
          conflict = ` on conflict (${keys.map(q).join(", ")}) do ` +
            (setCols.length
              ? `update set ${setCols.map((c) => `${q(c)} = excluded.${q(c)}`).join(", ")}`
              : "nothing");
        }
        text = `insert into ${q(this.table)} (${cols.map(q).join(", ")}) values ${tuples.join(", ")}${conflict} returning *`;
        rows = await sql(text, p);
      } else if (this.op === "update") {
        const cols = Object.keys(this.values || {});
        if (!cols.length) return { data: [], error: null };
        const sets = cols.map((c) => { p.push(encode(this.table, c, (this.values as any)[c])); return `${q(c)} = $${p.length}`; });
        const where = this.buildWhere(p);
        // A filterless UPDATE would rewrite the whole table. The app never
        // intends that; refuse rather than trust the caller.
        if (!where) throw new Error(`refusing unfiltered update on ${this.table}`);
        text = `update ${q(this.table)} set ${sets.join(", ")}${where} returning *`;
        rows = await sql(text, p);
      } else {
        const where = this.buildWhere(p);
        if (!where) throw new Error(`refusing unfiltered delete on ${this.table}`);
        text = `delete from ${q(this.table)}${where} returning *`;
        rows = await sql(text, p);
      }

      if (this.wantSingle) {
        if (!rows.length) {
          return this.allowNoRow
            ? { data: null, error: null }
            : { data: null, error: { message: "no rows returned" } };
        }
        return { data: rows[0], error: null };
      }
      return { data: rows, error: null };
    } catch (e: any) {
      // Mirror Supabase: errors are RETURNED, not thrown, so the ~130 call sites
      // that check `if (error)` keep behaving identically.
      return { data: null, error: { message: e?.message || String(e) } };
    }
  }

  then<R1 = { data: any[]; error: Err; count?: number | null }, R2 = never>(
    onfulfilled?: ((v: { data: any[]; error: Err; count?: number | null }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((r: any) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.run().then(onfulfilled as any, onrejected);
  }
}

/** Drop-in replacement for the Supabase service-role client. */
export function db() {
  return {
    from: (table: string) => new Builder(table),
    /** S3-backed, shaped like Supabase storage (see ./s3). */
    storage: storage(),

    /** Only the reconstructed pgvector search is exposed. */
    async rpc(name: string, args: Record<string, unknown>) {
      if (name !== "match_knowledge_chunks") {
        return { data: null, error: { message: `rpc not allowed: ${name}` } };
      }
      try {
        const rows = await sql<any>(
          `select * from public.match_knowledge_chunks($1::vector, $2::int, $3::double precision)`,
          [args.query_embedding, args.match_count ?? 8, args.min_similarity ?? 0],
        );
        return { data: rows, error: null };
      } catch (e: any) {
        return { data: null, error: { message: e?.message || String(e) } };
      }
    },
  };
}
