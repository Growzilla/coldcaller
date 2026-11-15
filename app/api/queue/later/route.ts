import { NextResponse } from "next/server";
import { nextLead, queuePreview, queueCounts, snoozeLead } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * "Later" — put the current lead off and advance the queue (the lead stays queued and comes back by itself).
 * Body: { leadId, hours?: number (default 24), country?, source? }
 */
export async function POST(req: Request) {
  const body = await req.json();
  const leadId = Number(body.leadId);
  if (!leadId) return NextResponse.json({ error: "leadId required" }, { status: 400 });
  const hours = Math.min(Math.max(Number(body.hours) || 24, 1), 24 * 30);
  snoozeLead(leadId, hours);
  const country = body.country ? String(body.country) : null;
  const source = body.source ? String(body.source) : null;
  return NextResponse.json({
    currentLead: nextLead(country, source) ?? null,
    queue: queuePreview(country, source),
    counts: queueCounts(country, source),
  });
}
