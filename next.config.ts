import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Playwright is only used by the MA deep-paginator when PLAYWRIGHT_ENABLED=true.
  // Keep it external so serverless bundles stay small and the build never traces it.
  serverExternalPackages: ["playwright"],
};

export default nextConfig;
