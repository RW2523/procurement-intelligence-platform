import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";

/**
 * Auth gate for procurement.
 *  1. Refreshes the Supabase session and ALLOWS any authenticated user — this is how a
 *     login on Immigration/Timesheets carries over here via the shared .ajace.com cookie.
 *  2. Transition fallback: while SITE_PASSWORD is set, non-session requests still pass the
 *     legacy Basic-Auth gate (so nothing breaks). Remove SITE_PASSWORD to make Supabase
 *     login the sole gate.
 *  3. Otherwise → redirect to /login.
 * The cron endpoint is exempt (its own CRON_SECRET); /login and /auth/* are public.
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/cron).*)"],
};

export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const cookieDomain = process.env.NEXT_PUBLIC_COOKIE_DOMAIN;

  let response = NextResponse.next({ request: req });
  let authed = false;

  if (url && anon) {
    const supabase = createServerClient(url, anon, {
      ...(cookieDomain ? { cookieOptions: { domain: cookieDomain } } : {}),
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (toSet: { name: string; value: string; options?: Record<string, unknown> }[]) => {
          for (const { name, value } of toSet) req.cookies.set(name, value);
          response = NextResponse.next({ request: req });
          for (const { name, value, options } of toSet) response.cookies.set(name, value, options as never);
        },
      },
    });
    const { data } = await supabase.auth.getUser();
    authed = Boolean(data.user);
  }

  // Signed in (incl. SSO from another AJACE app) → allow.
  if (authed) return response;

  // Public auth routes are always reachable.
  if (path === "/login" || path.startsWith("/auth")) return response;

  // Transition fallback: the legacy SITE_PASSWORD Basic-Auth gate still works until removed.
  const pw = process.env.SITE_PASSWORD;
  if (pw) {
    const authHeader = req.headers.get("authorization");
    if (authHeader?.startsWith("Basic ")) {
      try {
        const decoded = atob(authHeader.slice(6));
        if (decoded.slice(decoded.indexOf(":") + 1) === pw) return response;
      } catch {
        /* fall through to the challenge */
      }
    }
    return new NextResponse("Authentication required", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="AJACE Procurement Intelligence"' },
    });
  }

  // No session and no SITE_PASSWORD → Supabase login required.
  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  return NextResponse.redirect(loginUrl);
}
