import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

/**
 * Access gate for procurement.
 *
 * Next 16 renamed the `middleware` convention to `proxy` (and it runs on the
 * Node.js runtime, not edge) — see node_modules/next/dist/docs → version-16.
 *
 * This checks only that a valid SHARED session exists: one login on the
 * timesheet app carries over here, because both apps sit on the same host and
 * share auth_users, the cookie name and AUTH_JWT_SECRET.
 *
 * It deliberately does NOT decide whether the person may use procurement. That
 * needs a database lookup for their procurement `users` row and role, which is
 * enforced per-request in lib/auth/guard.ts. Being signed in gets you to the
 * app; having a procurement account with the right role gets you data.
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/cron).*)"],
};

const SESSION_COOKIE = "ts_session";

export async function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (path === "/login" || path === "/no-access" || path.startsWith("/auth")) {
    return NextResponse.next();
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  let authed = false;
  const secret = process.env.AUTH_JWT_SECRET;
  if (token && secret && secret.length >= 32) {
    try {
      await jwtVerify(token, new TextEncoder().encode(secret));
      authed = true;
    } catch {
      authed = false;  // expired, tampered, or a different secret
    }
  }
  if (authed) return NextResponse.next();

  // Not signed in: send them to the shared login, and come back here after.
  const signIn = process.env.NEXT_PUBLIC_LOGIN_URL;
  if (signIn) {
    const back = `${req.nextUrl.origin}${path}`;
    return NextResponse.redirect(`${signIn}?next=${encodeURIComponent(back)}`);
  }
  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  return NextResponse.redirect(loginUrl);
}
