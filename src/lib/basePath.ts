/**
 * The single source of truth for where this app is mounted.
 *
 * Imported by BOTH:
 *   - next.config.ts, to feed Next's own `basePath` (which rewrites <Link>
 *     hrefs, router navigations, asset URLs and `headers()` sources), and
 *   - src/lib/apiPath.ts, whose api() prefixes client fetch() URLs — something
 *     Next does NOT do for you.
 *
 * These two MUST agree. They previously read NEXT_PUBLIC_BASE_PATH separately
 * with DIFFERENT fallbacks (`|| "/procurement"` in the config, `?? ""` here),
 * so with the variable unset — which is its normal state: it is set only in
 * deploy/env.production.example, never in .env.local — Next mounted the app at
 * /procurement while api() emitted unprefixed "/api/..." paths. Every client
 * fetch then left this app for the site root, which is the timesheet app, and
 * 404'd. tsc and the build both stayed green, so nothing caught it.
 *
 * Deriving the value once removes the possibility of that drift: whatever the
 * mount point is, both consumers get the identical string by construction.
 *
 * `||` (not `??`) is deliberate and matches the previous config behaviour: an
 * empty NEXT_PUBLIC_BASE_PATH falls back rather than mounting at the root.
 * Root is not a supported mount here anyway — the timesheet app owns "/".
 *
 * NOTE: the value is inlined into the client bundle at build time (see the
 * basePath docs: "must be set at build time and cannot be changed without
 * re-building"), so changing the mount point requires a rebuild, not a restart.
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "/procurement";
