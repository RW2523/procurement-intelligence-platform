import type { NextConfig } from "next";

const SECURITY_HEADERS = [
  // HSTS is added only when actually on HTTPS — see below.
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  // Served under /procurement on the SAME origin as the timesheet app, so the
  // shared session cookie is sent to both. Separate ports or subdomains would
  // break that (a raw EC2 IP has no domain to scope a cookie to).
  basePath: "/procurement",
  // Playwright is only used by the MA deep-paginator when PLAYWRIGHT_ENABLED=true.
  // Keep it external so serverless bundles stay small and the build never traces it.
  serverExternalPackages: ["playwright"],
  poweredByHeader: false,
  async headers() {
    const headers = [...SECURITY_HEADERS];
    if (process.env.COOKIE_SECURE === "true") {
      headers.push({ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" });
    }
    return [{ source: "/:path*", headers }];
  },
};

export default nextConfig;
