/**
 * Prefix an app route with the basePath.
 *
 * Next rewrites <Link> hrefs and router navigations for basePath, but it does
 * NOT touch fetch() URLs. A client-side fetch("/api/crawl") therefore leaves
 * this app entirely and hits whatever is mounted at the site root — here, the
 * timesheet app — which 404s. Every client fetch must go through this.
 *
 * The prefix comes from src/lib/basePath.ts — the SAME module next.config.ts
 * uses for Next's `basePath`, so the mount point and this prefix cannot
 * disagree. Do NOT go back to reading NEXT_PUBLIC_BASE_PATH here: this file and
 * the config each having their own fallback for that variable is exactly how
 * the two silently diverged before (the config fell back to "/procurement",
 * this fell back to ""), which un-prefixed every client fetch in the app.
 */
import { BASE_PATH } from "./basePath";

export function api(path: string): string {
  if (!BASE_PATH) return path;
  return path.startsWith("/") ? `${BASE_PATH}${path}` : `${BASE_PATH}/${path}`;
}
