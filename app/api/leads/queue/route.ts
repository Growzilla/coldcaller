import { NextResponse } from "next/server";
import { queuePreview, queueCounts, countryBreakdown, sourceBreakdown } from "@/lib/db";

export const dynamic = "force-dynamic";

// Bearer-authed on hosted deploys via middleware.ts (DIALER_API_TOKEN). Open locally.

/**
 * GET /api/leads/queue?country=&source=&limit= — the dialable queue + counts.
 * Lets HermesAgent see what's left to call (and in what order: priority, then id).
 */
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const country = p.get("country") || null;
  const source = p.get("source") || null;
  const limit = Math.min(Math.max(Number(p.get("limit")) || 50, 1), 500);
  return NextResponse.json({
    counts: queueCounts(country, source),
    queue: queuePreview(country, source, limit),
    countries: countryBreakdown(),
    sources: sourceBreakdown(),
  });
}
