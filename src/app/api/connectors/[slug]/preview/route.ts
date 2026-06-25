import { NextRequest, NextResponse } from "next/server";
import { getConnector } from "@/lib/connectors/registry";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Live connector smoke test — fetches a few real opportunities. No DB required. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? "5");
  const connector = getConnector(slug);
  if (!connector) return NextResponse.json({ error: `No connector for "${slug}"` }, { status: 404 });

  try {
    const result = await connector.fetchOpenOpportunities({ limit });
    return NextResponse.json({
      key: slug,
      label: connector.label,
      methodUsed: result.methodUsed,
      count: result.opportunities.length,
      warnings: result.warnings,
      sample: result.opportunities.slice(0, limit),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
