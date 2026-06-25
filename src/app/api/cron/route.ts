import { NextRequest, NextResponse } from "next/server";
import { runAllCrawls } from "@/lib/crawl/runner";
import { scanDeadlines } from "@/lib/notify/deadlines";
import { dbConfigured } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Scheduled entry point. Wire this to Vercel Cron (vercel.json) or any external
 * scheduler hitting it daily at ~06:00 ET. Optionally protect with CRON_SECRET.
 */
async function run(req: NextRequest) {
  if (!dbConfigured) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const summaries = await runAllCrawls({ trigger: "scheduled" });
  const deadlines = await scanDeadlines();
  return NextResponse.json({ ranAt: new Date().toISOString(), summaries, deadlines });
}

export const GET = run;
export const POST = run;
