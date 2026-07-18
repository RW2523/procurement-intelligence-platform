import { NextResponse } from "next/server";
import { createAuthServerClient } from "@/lib/supabase/auth-server";

export const runtime = "nodejs";

/** POST /auth/signout — ends the Supabase session and returns to the login page. */
export async function POST(request: Request) {
  const supabase = await createAuthServerClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
}
