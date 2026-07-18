"use client";
import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser Supabase client (anon key) for client-side auth flows (e.g. signout).
 * Shares the SSR session cookie; SSO cookie-domain via NEXT_PUBLIC_COOKIE_DOMAIN.
 */
export function createAuthBrowserClient() {
  const cookieDomain = process.env.NEXT_PUBLIC_COOKIE_DOMAIN;
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    cookieDomain ? { cookieOptions: { domain: cookieDomain } } : undefined,
  );
}
