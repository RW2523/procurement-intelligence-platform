import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

/**
 * Anon-key Supabase client bound to the request's auth cookies. Used ONLY for
 * authentication (who is signed in) — reading the session and running the login /
 * signout flows. Data access still goes through the service-role client in
 * `./server`. Sharing the cookie across *.ajace.com subdomains (SSO) is enabled by
 * NEXT_PUBLIC_COOKIE_DOMAIN in production.
 */
export async function createAuthServerClient() {
  const cookieStore = await cookies();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const cookieDomain = process.env.NEXT_PUBLIC_COOKIE_DOMAIN;
  return createServerClient(url, anon, {
    ...(cookieDomain ? { cookieOptions: { domain: cookieDomain } } : {}),
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet: { name: string; value: string; options?: Record<string, unknown> }[]) => {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options as never);
        } catch {
          // Called during a Server Component render — safe to ignore; middleware refreshes.
        }
      },
    },
  });
}
