import type { NextConfig } from "next";
import { BASE_PATH } from "./src/lib/basePath";

const SECURITY_HEADERS = [
  // HSTS is added only when actually on HTTPS — see below.
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

/**
 * Content-Security-Policy for every page and route EXCEPT the attachment byte
 * stream (see CSP_SOURCE below).
 *
 * WHY THIS APP NEEDS ITS OWN. CSP is a per-RESPONSE header, so the timesheet
 * app's policy (ajace-timesheet-aws/next.config.js) covers only the responses
 * the timesheet serves. After the HTTPS cutover both apps sit on ONE origin
 * behind Caddy — https://<host>/ and https://<host>/procurement — sharing one
 * session cookie. Until now the /procurement half of that origin shipped no CSP
 * at all (Caddy adds none either: deploy/scripts/render-caddyfile.sh has no
 * `header` directive), and it is the half that renders bytes crawled from
 * third-party procurement portals. An injection here executes on the origin
 * that holds the payroll cookie, so the origin's weakest response defines its
 * real security. This closes that half.
 *
 * NO NONCE, deliberately. Nonce-based CSP requires every page to be dynamically
 * rendered — node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md:
 * "When you use nonces in your CSP, all pages must be dynamically rendered",
 * which disables static optimization and ISR. This app shares a 2 GB box with
 * payroll, and 'unsafe-inline' is also what the timesheet already uses on the
 * same origin; a policy that differs per half of one origin is a policy nobody
 * can reason about. 'unsafe-eval' is added only outside production, where React
 * uses eval to rebuild server error stacks (same doc).
 *
 * frame-ancestors is 'none', NOT 'self'. It has to match the X-Frame-Options
 * DENY above: a browser that understands frame-ancestors IGNORES X-Frame-Options
 * entirely, so writing 'self' here would have quietly turned the app's existing
 * DENY into "same-origin framing allowed" in every modern browser. Nothing
 * frames these pages — the one thing that IS framed is the attachment endpoint,
 * which is excluded from this policy and permits it in its own header.
 *
 * NO upgrade-insecure-requests. Before the cutover this origin is plain http on
 * the raw EC2 IP; the directive would upgrade every same-origin subresource to
 * an https port Caddy is not serving, breaking the app for exactly the people
 * running it pre-cutover. Caddy redirects http→https after the cutover anyway.
 *
 * Directive-by-directive, against what this app actually loads:
 *   script-src  'self' + inline: Next's bootstrap/flight inline scripts.
 *   style-src   'self' + inline: Tailwind v4 output plus React inline `style`
 *               props (DocumentsPanel's iframe height, recharts' generated SVG).
 *   img-src     'self' — the document preview <img> points at this app's own
 *               /api/attachments/:id/file. data: for icon/CSS data URIs.
 *   font-src    'self' — next/font/google downloads Geist AT BUILD TIME and
 *               self-hosts it under /_next/static/media, so no font is fetched
 *               from Google at runtime and no external origin is needed.
 *   connect-src 'self' — every client fetch() goes through src/lib/apiPath.ts
 *               to this app's own /procurement/api/*. Crawling and OpenRouter
 *               calls happen server-side, where CSP does not apply.
 *   frame-src   'self' — DocumentsPanel <iframe>s the attachment endpoint.
 *   object-src / base-uri / form-action — no plugins, no <base>, and forms
 *               (including the timesheet's login, same origin) never post off-site.
 */
const isDev = process.env.NODE_ENV !== "production";
const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  // ws: only outside production: `next dev`'s HMR socket is ws://<host>, and
  // whether bare 'self' covers a ws: URL of the same origin is a CSP Level 3
  // detail browsers have not always agreed on. Production ships 'self' alone.
  `connect-src 'self'${isDev ? " ws:" : ""}`,
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Everything EXCEPT /api/attachments/<id>/file.
 *
 * This has to be an exclusion rather than an override. A config header is set on
 * the ServerResponse before the route handler runs, and send-response.js then
 * appends a handler header ONLY if it is absent (verified in the installed
 * next@16.2.9: `if (headersWithMultipleValuesAllowed.includes(...) ||
 * !isHeaderPresent)`, where the allow-list is set-cookie / www-authenticate /
 * proxy-authenticate / vary). So ANY config CSP on that path — even one meant to
 * restate the handler's — silently deletes `default-src 'none'; sandbox;
 * frame-ancestors 'self'`, the sandbox that neutralises attacker-supplied
 * crawled bytes and the frame-ancestors that lets DocumentsPanel preview them.
 * Excluding the path leaves that handler as the single source of truth, exactly
 * as the note above FRAMEABLE_ATTACHMENT_HEADERS requires.
 *
 * The `:path(...)?` shape — optional, not `/((?!...).*)`— is load-bearing: a
 * required unnamed group never matches the BARE basePath. Checked against this
 * app's own matcher (next/dist/shared/lib/router/utils/path-match with
 * basePath prefixed): `/procurement/((?!…).*)` does NOT match `/procurement`,
 * which is the dashboard, so the landing page would have shipped with no CSP.
 * src/proxy.ts documents the same trap for its own matcher and works around it
 * by listing "/" separately; that trick is not available here, because with
 * basePath a `source` of "/" becomes "/procurement/", which likewise does not
 * match "/procurement". With the optional form all of /procurement,
 * /procurement/, /procurement/board and /procurement/api/bids match, while
 * /procurement/api/attachments/<id>/file does not — and neither does anything
 * else, because the lookahead is anchored with `$`.
 */
const CSP_SOURCE = "/:path((?!api/attachments/[^/]+/file$).*)?";

/**
 * The one route that must be frameable: the stored-attachment byte stream that
 * DocumentsPanel renders in an <iframe> for PDF preview. Blanket
 * `X-Frame-Options: DENY` above breaks that preview — DENY refuses framing even
 * by the SAME origin, so the app cannot embed its own document endpoint.
 *
 * `X-Frame-Options: SAMEORIGIN` OVERRIDES the DENY from the `/:path*` rule above
 * (later matching rule wins for the same key, per the Next headers docs) but only
 * on this one path. Every other route — the whole payroll-adjacent UI — keeps DENY
 * and stays unframeable, so the clickjacking protection is intact.
 *
 * `source` is auto-prefixed with basePath, so this matches the real request path
 * /procurement/api/attachments/<id>/file (see "Headers with basePath support").
 *
 * !! DO NOT ADD Content-Security-Policy HERE. !!
 * Config headers are applied to the ServerResponse BEFORE the route handler runs
 * (server/lib/router-server.js -> `res.setHeader(key, resHeaders[key])`). When the
 * handler's own Response is then flushed by server/send-response.js, that code only
 * appends a header if it is absent or is one of set-cookie / www-authenticate /
 * proxy-authenticate / vary. `content-security-policy` is NOT on that list, so a CSP
 * set here SILENTLY DELETES the handler's own CSP instead of merging with it — and
 * this route deliberately ships `default-src 'none'; sandbox`, the only defence left
 * once attacker-influenced crawled bytes are served from the origin that also serves
 * payroll. Framing is governed by that handler's `frame-ancestors 'self'` (the modern
 * control) with the SAMEORIGIN below as the legacy fallback; see
 * src/app/api/attachments/[id]/file/route.ts.
 */
const FRAMEABLE_ATTACHMENT_HEADERS = [
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
];

const nextConfig: NextConfig = {
  // Deploys must NEVER build into the directory the live server is reading.
  // `next start` resolves static chunks and not-yet-required server bundles from
  // distDir BY PATH at request time, and re-reads BUILD_ID from it on boot, so a
  // build that empties .next breaks the running app for the whole build and turns
  // any restart in that window into a "Could not find a production build" crash
  // loop. deploy/scripts/install.sh builds with NEXT_DIST_DIR=.next.build and
  // renames the finished directory into place; `next start` runs WITHOUT that
  // variable and so always serves plain `.next`. distDir is read from this file
  // at runtime (server/lib/router-server.js), never baked into the output.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Served under /procurement on the SAME origin as the timesheet app, so the
  // shared session cookie is sent to both. Separate ports or subdomains would
  // break that (a raw EC2 IP has no domain to scope a cookie to).
  // Shared with src/lib/apiPath.ts so the mount point and the prefix that
  // client fetch() calls use can never disagree. See src/lib/basePath.ts.
  basePath: BASE_PATH,
  // Playwright is only used by the MA deep-paginator when PLAYWRIGHT_ENABLED=true.
  // Keep it external so serverless bundles stay small and the build never traces it.
  serverExternalPackages: ["playwright"],
  poweredByHeader: false,
  experimental: {
    // Next 16 clones and buffers the request body in memory for every non-GET
    // request that proxy.ts matches (which is all of /api/bids), so this is the
    // FIRST memory bound any upload meets — it is reached before a route
    // handler runs. Past the limit the body is silently TRUNCATED, not
    // rejected, so it must be >= the upload cap or a legitimate multipart body
    // would arrive corrupt and surface as an unexplained 400.
    //
    // MUST EQUAL MAX_UPLOAD_REQUEST_BYTES in src/lib/documents/limits.ts.
    // Left at the 10 MB default it would silently cap uploads well below the
    // limit the API advertises; raised beyond it, the proxy would buffer more
    // than the API will ever accept. 32 MB on a 2 GB box shared with payroll.
    proxyClientMaxBodySize: "32mb",
  },
  async headers() {
    const headers = [...SECURITY_HEADERS];
    // WHERE THIS VALUE COMES FROM — it is NOT this repo's .env.production.
    //
    // The deploy path is ajace-timesheet-aws/deploy/scripts/install.sh, which
    // sources the TIMESHEET's .env.production with `set -a` and therefore has
    // COOKIE_SECURE already in the environment when it runs `npm run build`
    // here. @next/env never overwrites a key that is already in process.env
    // (node_modules/@next/env/dist/index.js skips any key present in its
    // original process.env snapshot), so this app's own .env.production is inert
    // for COOKIE_SECURE — and for every other key the two files share.
    //
    // That is correct rather than accidental: the two apps are ONE origin
    // sharing ONE session cookie, and the timesheet is what issues it, so "is
    // this origin HTTPS?" has a single owner. Do not "fix" it by editing this
    // repo's .env.production — that changes nothing. install.sh step [5b]
    // rewrites this repo's copy to match the timesheet's and prints a line
    // saying it did, so the file on disk always shows what is in effect; and it
    // refuses to deploy at all when the box has a hostname and the timesheet's
    // value is not the literal "true".
    if (process.env.COOKIE_SECURE === "true") {
      // Both of these are ignored by browsers on a non-HTTPS origin (COOP logs a
      // console warning saying so), and HSTS on plain HTTP would lock users out.
      headers.push({ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" });
      headers.push({ key: "Cross-Origin-Opener-Policy", value: "same-origin" });
    }
    return [
      { source: "/:path*", headers },
      // Separate rule, because its `source` excludes one path that the catch-all
      // must still cover for every OTHER header (nosniff, Referrer-Policy, HSTS…).
      { source: CSP_SOURCE, headers: [{ key: "Content-Security-Policy", value: CSP }] },
      // Must come AFTER the catch-all: for a shared header key the last matching
      // rule wins, which is how SAMEORIGIN replaces DENY on this path alone.
      { source: "/api/attachments/:id/file", headers: FRAMEABLE_ATTACHMENT_HEADERS },
    ];
  },
};

export default nextConfig;
