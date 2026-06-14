import { NextResponse } from "next/server";
import { recentCalls } from "@/lib/db";

export const dynamic = "force-dynamic";

// Bearer-authed on hosted deploys via middleware.ts (DIALER_API_TOKEN). Open locally.

function parseMaybe(s: unknown) {
  if (typeof s !== "string") return s;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/**
 * GET /api/calls/recent?limit=&since= — recent calls with outcome, duration,
 * transcript and parsed analysis, each joined to its lead. HermesAgent's call-memory
 * feed. `since` = highest call id already seen, so Hermes polls only what's new.
 */
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const limit = Number(p.get("limit")) || 50;
  const sinceId = Number(p.get("since")) || 0;
  const calls = recentCalls(limit, sinceId).map((c) => ({
    ...c,
    analysis: parseMaybe((c as Record<string, unknown>).analysis),
  }));
  const maxId = calls.reduce((m, c) => Math.max(m, c.id), sinceId);
  return NextResponse.json({ count: calls.length, maxId, calls });
}
