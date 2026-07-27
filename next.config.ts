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
    if (process.env.COOKIE_SECURE === "true") {
      // Both of these are ignored by browsers on a non-HTTPS origin (COOP logs a
      // console warning saying so), and HSTS on plain HTTP would lock users out.
      headers.push({ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" });
      headers.push({ key: "Cross-Origin-Opener-Policy", value: "same-origin" });
    }
    return [
      { source: "/:path*", headers },
      // Must come AFTER the catch-all: for a shared header key the last matching
      // rule wins, which is how SAMEORIGIN replaces DENY on this path alone.
      { source: "/api/attachments/:id/file", headers: FRAMEABLE_ATTACHMENT_HEADERS },
    ];
  },
};

export default nextConfig;
