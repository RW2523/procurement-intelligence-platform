/**
 * The two routes that must render for someone who does NOT have procurement
 * access, and the header src/proxy.ts uses to tell the root layout which route
 * is being served.
 *
 * Shared by src/proxy.ts and src/app/layout.tsx so the exempt list cannot drift
 * between the redirect gate and the render gate — the layout failing open on a
 * path the proxy already lets through is exactly the hole this closes.
 *
 * No `server-only` import here on purpose: proxy.ts must be able to import it.
 */
export const PATHNAME_HEADER = "x-ajace-pathname";

/** Routes that render without a procurement account. Keep this list tiny. */
const PUBLIC_PATHS = new Set(["/login", "/no-access"]);

/**
 * Unknown pathname (header missing) counts as PROTECTED, not public: the layout
 * gate must fail closed when it cannot tell where it is.
 */
export function isPublicPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const path = pathname.replace(/\/+$/, "") || "/";
  return PUBLIC_PATHS.has(path) || path.startsWith("/auth");
}
