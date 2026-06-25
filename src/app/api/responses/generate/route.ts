import { NextRequest, NextResponse } from "next/server";
import { generateResponseDraft } from "@/lib/ai/generate";
import { dbConfigured } from "@/lib/supabase/server";
import type { ResponseMode } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

/** POST { opportunityId, mode? } — generate one or both AI drafts. */
export async function POST(req: NextRequest) {
  if (!dbConfigured) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const { opportunityId, mode } = await req.json().catch(() => ({}));
  if (!opportunityId) return NextResponse.json({ error: "opportunityId required" }, { status: 400 });

  const modes: ResponseMode[] = mode ? [mode] : ["STYLE_MATCHED", "LLM_ORIGINAL"];
  const out = [];
  for (const m of modes) {
    const r = await generateResponseDraft(opportunityId, m);
    out.push({ id: r.id, mode: r.mode, model_used: r.model_used, chars: r.content.length });
  }
  return NextResponse.json({ generated: out });
}
