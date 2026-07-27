import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";
import { PATHNAME_HEADER, isPublicPath } from "@/lib/auth/public-routes";
import { sql, dbConfigured } from "@/lib/db/pg";

/**
 * Access gate for procurement.
 *
 * Next 16 renamed the `middleware` convention to `proxy` (and it runs on the
 * Node.js runtime, not edge) — see node_modules/next/dist/docs → version-16.
 * Node runtime is what makes the database check below possible at all.
 *
 * Identity is the SHARED session: one login on the timesheet app carries over
 * here, because both apps sit on the same host and share auth_users, the cookie
 * name and AUTH_JWT_SECRET.
 *
 * This ALSO decides whether the request may reach a page, and it has to, because
 * NO RENDER-TIME CHECK CAN UNDO A RENDER. Verified on this app: a layout that
 * swaps a refusal in for `children` still lets the page segment render, and its
 * rows are serialised into the RSC payload of the very response that shows the
 * refusal (measured on /notifications, and again on /opportunities behind its
 * segment layout — the refusal screen was returned WITH the opportunity rows in
 * the flight data). Verifying only the JWT signature here was what let those
 * requests in: a session revoked by a password reset or "sign out everywhere"
 * (auth_users.session_version) still carries a perfectly valid signature until
 * the token expires. A request refused here never reaches a page at all.
 *
 * ROLES are still authorized per-request, close to the data: pageGate() in
 * lib/auth/page-gate.tsx for pages, requireUser()/requireRole() in
 * lib/auth/guard.ts for server actions and route handlers. This says "you may
 * enter"; those say "you may do that". Both layers are load-bearing — this one
 * cannot see which role a screen needs, and those cannot un-send bytes.
 */
export const config = {
  // "/" is listed SEPARATELY and is not redundant: the negative-lookahead
  // pattern below never matches the bare root — verified against this app, where
  // `GET /` was logged with no `proxy.ts` phase at all while every other path had
  // one, so the dashboard (the app's landing page, and the deepest read of the
  // pipeline outside /opportunities) was the one route that reached the renderer
  // ungated, signed in or not.
  matcher: ["/", "/((?!_next/static|_next/image|favicon.ico|api/cron).*)"],
};

const SESSION_COOKIE = "ts_session";

type Claims = { id: string; sv: number };

/**
 * Session revocation and procurement access in ONE indexed round trip.
 *   no row              → the session was revoked (session_version moved on),
 *                         or the login itself is gone
 *   row, has_access f   → signed in to AJACE, but no usable procurement account
 *                         (none at all, or is_active = false — getCurrentUser()
 *                         treats both as "no account", so this must too)
 */
async function accessFor(claims: Claims): Promise<"ok" | "revoked" | "denied"> {
  const rows = await sql<{ has_access: boolean }>(
    `select coalesce(p.is_active, false) as has_access
       from public.auth_users u
       left join public.users p on lower(p.email) = lower(u.email)
      where u.id = $1 and u.session_version = $2
      limit 1`,
    [claims.id, claims.sv],
  );
  if (rows.length === 0) return "revoked";
  return rows[0].has_access ? "ok" : "denied";
}

export async function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;

  /**
   * Pass the resolved pathname upstream. A layout cannot read the pathname
   * (layouts do not re-render on navigation, so it would go stale — see
   * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/layout.md:240),
   * and the root layout needs it to know whether it is rendering one of the two
   * public routes. Cloning `req.headers` and `set()`ing the value overwrites
   * anything a client sent under the same name, so it cannot be spoofed on any
   * path this proxy matches.
   */
  const forward = () => {
    const headers = new Headers(req.headers);
    headers.set(PATHNAME_HEADER, path);
    return NextResponse.next({ request: { headers } });
  };

  if (isPublicPath(path)) return forward();

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  let claims: Claims | null = null;
  const secret = process.env.AUTH_JWT_SECRET;
  if (token && secret && secret.length >= 32) {
    try {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(secret));
      // Same claim shape lib/auth/session.ts reads. A token with no subject is a
      // token whose session cannot be checked for revocation, so it is not one.
      if (payload.sub) claims = { id: String(payload.sub), sv: Number(payload.sv ?? 1) };
    } catch {
      claims = null;  // expired, tampered, or a different secret
    }
  }

  if (claims) {
    // Route handlers answer in JSON and authorize themselves (every one of them
    // calls requireRole/requireUser, which do check session_version through
    // getSessionEmail). Sending them down the page path below would turn their
    // 403 into an HTML redirect. Being signed in is still required — checked above.
    if (path.startsWith("/api/")) return forward();

    // No DATABASE_URL is the pre-configuration state: there is nothing to read
    // and nothing to protect, and the app deliberately still boots to say so.
    if (!dbConfigured) return forward();

    let access: "ok" | "revoked" | "denied";
    try {
      access = await accessFor(claims);
    } catch (err) {
      // FAIL CLOSED. An unreachable database must not become an open door — that
      // is the exact shape of the bug this gate replaces. "No access" would also
      // be a lie during an outage, so say the true thing instead.
      console.error("[auth] proxy could not verify access:", err);
      return new NextResponse("Procurement is temporarily unavailable. Please try again shortly.", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (access === "ok") return forward();

    if (access === "denied") {
      // Signed in, but no usable procurement account. REWRITE rather than
      // redirect: the URL they asked for is preserved, the page they asked for
      // never runs (so nothing of it can reach the payload), and there is no
      // redirect to loop on. The forwarded pathname is /no-access so the root
      // layout treats this render as the public route it now is and lets
      // no-access/page.tsx explain — with their email, and the deactivated case
      // worded differently — instead of blanking it.
      const noAccess = req.nextUrl.clone();
      noAccess.pathname = "/no-access";
      noAccess.search = "";
      const headers = new Headers(req.headers);
      headers.set(PATHNAME_HEADER, "/no-access");
      return NextResponse.rewrite(noAccess, { request: { headers } });
    }

    // access === "revoked": the cookie is intact but the session behind it is
    // not, so fall through and treat it exactly like not being signed in.
  }

  // Not signed in: send them to the shared login, and come back here after.
  const signIn = process.env.NEXT_PUBLIC_LOGIN_URL;
  if (signIn) {
    // MUST be `href`, not `origin + pathname`. Inside a proxy, `nextUrl.pathname`
    // is basePath-STRIPPED: NextURL.analyze() assigns the stripped path to
    // `url.pathname` and stashes "/procurement" separately on `basePath` (see
    // node_modules/next/dist/server/web/next-url.js). Only `href` runs
    // formatPathname(), which puts the basePath back. Building the return URL
    // from `pathname` hands the timesheet a bare "/opportunities" — a path that
    // exists on the TIMESHEET app, not here — so every user who signs in from a
    // deep link lands in the wrong app. `href` also preserves the query string,
    // which the old expression silently dropped.
    const back = req.nextUrl.href;
    return NextResponse.redirect(`${signIn}?next=${encodeURIComponent(back)}`);
  }
  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  return NextResponse.redirect(loginUrl);
}
