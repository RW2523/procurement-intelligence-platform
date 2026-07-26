import { NextResponse } from "next/server";

/**
 * Signing out is owned by the app that issues the session (the timesheet app),
 * because the cookie is shared: clearing it here would sign the person out of
 * both, and only that app knows the correct cookie attributes to clear it with.
 */
export async function POST() {
  const signOut = process.env.NEXT_PUBLIC_LOGOUT_URL;
  return NextResponse.redirect(signOut || "/login", { status: 303 });
}
