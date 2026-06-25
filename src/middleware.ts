import { NextRequest, NextResponse } from "next/server";

/**
 * Optional site-wide Basic Auth gate for public (e.g. Vercel) deployments — so the
 * URL isn't wide open (the app has no per-user auth and can trigger paid AI calls).
 * Active only when SITE_PASSWORD is set. The cron endpoint is exempt (it has its own
 * CRON_SECRET). Locally, with SITE_PASSWORD unset, the gate is a no-op.
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/cron).*)"],
};

export function middleware(req: NextRequest) {
  const pw = process.env.SITE_PASSWORD;
  if (!pw) return NextResponse.next();

  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Basic ")) {
    try {
      const decoded = atob(auth.slice(6));
      const pass = decoded.slice(decoded.indexOf(":") + 1);
      if (pass === pw) return NextResponse.next();
    } catch {
      /* fall through to 401 */
    }
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="AJACE Procurement Intelligence"' },
  });
}
