import { NextRequest, NextResponse } from "next/server";
import { runAllCrawls } from "@/lib/crawl/runner";
import { scanDeadlines } from "@/lib/notify/deadlines";
import { refreshUrgencyBands } from "@/lib/targeting/refresh";
import { dbConfigured } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Scheduled entry point. Wire this to Vercel Cron (vercel.json) or any external
 * scheduler hitting it daily at ~06:00 ET. Optionally protect with CRON_SECRET.
 */
async function run(req: NextRequest) {
  if (!dbConfigured) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  // FAIL CLOSED. This used to skip the check entirely when CRON_SECRET was
  // unset, so a missing env var silently exposed the crawl trigger to anyone.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[cron] refused: CRON_SECRET is not set");
    return NextResponse.json({ error: "Cron is not configured" }, { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const summaries = await runAllCrawls({ trigger: "scheduled" });
  const deadlines = await scanDeadlines();
  // Urgency bands drift daily as deadlines approach (§10) — refresh them.
  const urgency = await refreshUrgencyBands();
  return NextResponse.json({ ranAt: new Date().toISOString(), summaries, deadlines, urgency });
}

export const GET = run;
export const POST = run;
