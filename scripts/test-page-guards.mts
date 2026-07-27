/**
 * Route authorization coverage (run: npx tsx scripts/test-page-guards.mts).
 *
 * Every server page under src/app must refuse an unauthorized visitor BY
 * ITSELF. It is not enough for the root layout to swap the page out: Next does
 * not re-render a mounted layout on a client-side navigation, so a soft
 * navigation or a Link prefetch reaches the page segment with the root layout's
 * check skipped entirely —
 * node_modules/next/dist/docs/01-app/02-guides/authentication.md:1350 and :1446.
 *
 * A page counts as guarded when it either
 *   - calls pageGate() / getCurrentUser() / requireUser() / requireRole() itself, or
 *   - sits under a SEGMENT layout (any layout.tsx below src/app) that does, or
 *   - is one of the two routes that must render without procurement access.
 *
 * The root src/app/layout.tsx deliberately does NOT count. This exists so that a
 * page added tomorrow cannot inherit zero enforcement without the suite noticing.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(ROOT, "src", "app");

/** Routes that must render for someone with no procurement account. Keep tiny. */
const PUBLIC_PAGES = new Set(["login/page.tsx", "no-access/page.tsx"]);

const GUARD = /\b(pageGate|getCurrentUser|requireUser|requireRole)\s*\(/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry === "page.tsx" || entry === "layout.tsx") out.push(full);
  }
  return out;
}

const files = walk(APP);
const pages = files.filter((f) => f.endsWith("page.tsx"));
/** Segment layouts only — the root layout is not a gate. */
const guardingLayoutDirs = new Set(
  files
    .filter((f) => f.endsWith("layout.tsx") && dirname(f) !== APP && GUARD.test(readFileSync(f, "utf8")))
    .map((f) => dirname(f)),
);

function coveredByLayout(pageFile: string): string | null {
  let dir = dirname(pageFile);
  while (dir.startsWith(APP) && dir !== APP) {
    if (guardingLayoutDirs.has(dir)) return relative(APP, join(dir, "layout.tsx"));
    dir = dirname(dir);
  }
  return null;
}

let pass = 0;
const failures: string[] = [];

for (const file of pages.sort()) {
  const rel = relative(APP, file).split(sep).join("/");
  if (PUBLIC_PAGES.has(rel)) {
    console.log(`  public   ${rel}`);
    pass++;
    continue;
  }
  if (GUARD.test(readFileSync(file, "utf8"))) {
    console.log(`  guarded  ${rel}`);
    pass++;
    continue;
  }
  const layout = coveredByLayout(file);
  if (layout) {
    console.log(`  guarded  ${rel}  (via ${layout.split(sep).join("/")})`);
    pass++;
    continue;
  }
  console.log(`  UNGATED  ${rel}`);
  failures.push(rel);
}

console.log(
  `\n${failures.length === 0 ? "PASS" : "FAIL"}  ${pass} of ${pages.length} pages enforce authorization`,
);
if (failures.length) {
  console.log("\nThese pages rely on the root layout alone, which is skipped on client-side navigation:");
  for (const f of failures) console.log(`  - ${f}`);
  console.log("\nAdd at the top of the page body:  const { deny } = await pageGate(); if (deny) return deny;");
}
process.exit(failures.length === 0 ? 0 : 1);
