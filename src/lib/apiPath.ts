/**
 * Prefix an app route with the basePath.
 *
 * Next rewrites <Link> hrefs and router navigations for basePath, but it does
 * NOT touch fetch() URLs. A client-side fetch("/api/crawl") therefore leaves
 * this app entirely and hits whatever is mounted at the site root — here, the
 * timesheet app — which 404s. Every client fetch must go through this.
 *
 * Reads NEXT_PUBLIC_BASE_PATH (inlined at build time) so it stays correct if the
 * mount point ever changes, and returns the path unchanged when unset.
 */
const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export function api(path: string): string {
  if (!BASE) return path;
  return path.startsWith("/") ? `${BASE}${path}` : `${BASE}/${path}`;
}
