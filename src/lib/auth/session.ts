import "server-only";
import { cookies } from "next/headers";
import { jwtVerify } from "jose";

/**
 * Reads the session issued by the TIMESHEET app.
 *
 * Both apps run on the same host and share public.auth_users, the same cookie
 * name and the same AUTH_JWT_SECRET, so signing in once works for both. Holding
 * a valid session does NOT grant procurement access on its own: it only
 * establishes WHO you are. Authorization requires a procurement `users` row —
 * see getCurrentUser() and lib/auth/guard.ts.
 */
export const SESSION_COOKIE = "ts_session";

const secret = () => {
  const s = process.env.AUTH_JWT_SECRET;
  if (!s || s.length < 32) {
    throw new Error("AUTH_JWT_SECRET is missing or too short — refusing to verify sessions.");
  }
  return new TextEncoder().encode(s);
};

export type SessionClaims = { id: string; email: string; sv: number };

export async function readSession(): Promise<SessionClaims | null> {
  try {
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (!token) return null;
    const { payload } = await jwtVerify(token, secret());
    if (!payload.sub || !payload.email) return null;
    return { id: String(payload.sub), email: String(payload.email), sv: Number(payload.sv ?? 1) };
  } catch {
    return null;   // expired, tampered, or signed with a different secret
  }
}
