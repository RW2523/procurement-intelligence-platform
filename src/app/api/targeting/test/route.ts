import { NextRequest, NextResponse } from "next/server";
import { dbConfigured } from "@/lib/supabase/server";
import { getTargetingProfile } from "@/lib/targeting/profile";
import { scoreOpportunity } from "@/lib/targeting/engine";
import type { TargetingProfile } from "@/lib/types";

export const runtime = "nodejs";

/**
 * POST { title, description?, agency?, category?, naicsCode?, dueDate?, estimatedValue?,
 *        sourceState?, profile? } — score an ad-hoc solicitation against the live (or a
 * draft) profile. Powers the Admin "test the profile" sandbox.
 */
export async function POST(req: NextRequest) {
  if (!dbConfigured) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const body = await req.json().catch(() => ({}) as Record<string, unknown>);
  if (!body.title || typeof body.title !== "string") {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  const profile = (body.profile as TargetingProfile | undefined) ?? (await getTargetingProfile());
  const result = scoreOpportunity(
    {
      title: body.title as string,
      description: (body.description as string) ?? null,
      agency: (body.agency as string) ?? null,
      category: (body.category as string) ?? null,
      naicsCode: (body.naicsCode as string) ?? null,
      dueDate: (body.dueDate as string) ?? null,
      estimatedValue: typeof body.estimatedValue === "number" ? body.estimatedValue : null,
      sourceState: (body.sourceState as string) ?? null,
    },
    profile,
  );
  return NextResponse.json({ result });
}
