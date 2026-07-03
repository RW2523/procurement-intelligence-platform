import { NextRequest, NextResponse } from "next/server";
import { dbConfigured } from "@/lib/supabase/server";
import {
  getTargetingProfile,
  updateTargetingProfile,
  DEFAULT_TARGETING_PROFILE,
} from "@/lib/targeting/profile";
import type { TargetingProfile } from "@/lib/types";

export const runtime = "nodejs";

/** GET → the live targeting profile (with the seed defaults for reference). */
export async function GET() {
  if (!dbConfigured) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const profile = await getTargetingProfile();
  return NextResponse.json({ profile, defaults: DEFAULT_TARGETING_PROFILE });
}

/** PUT { profile, note? } → persist an edited profile (audit-versioned). */
export async function PUT(req: NextRequest) {
  if (!dbConfigured) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const body = await req.json().catch(() => null);
  const profile = body?.profile as TargetingProfile | undefined;
  if (!profile || !Array.isArray(profile.capabilities) || !profile.thresholds || !profile.dateBands) {
    return NextResponse.json({ error: "Body must include a full targeting profile" }, { status: 400 });
  }
  // Light structural validation so a bad save can't brick scoring.
  if (
    typeof profile.thresholds.pursue !== "number" ||
    typeof profile.thresholds.captureReview !== "number" ||
    typeof profile.thresholds.manualReview !== "number" ||
    typeof profile.dateBands.minDays !== "number"
  ) {
    return NextResponse.json({ error: "Thresholds and dateBands must be numeric" }, { status: 400 });
  }
  const saved = await updateTargetingProfile(profile, body?.changedBy ?? "admin", body?.note);
  return NextResponse.json({ profile: saved });
}
