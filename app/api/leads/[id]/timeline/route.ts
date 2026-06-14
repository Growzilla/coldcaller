import { NextResponse } from "next/server";
import { leadTimeline } from "@/lib/db";

export const dynamic = "force-dynamic";

// Bearer-authed on hosted deploys via middleware.ts (DIALER_API_TOKEN). Open locally.

/**
 * GET /api/leads/:id/timeline — one lead plus its full call history.
 * The "what happened to this prospect" view HermesAgent reasons from.
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "bad lead id" }, { status: 400 });
  }
  const { lead, calls } = leadTimeline(id);
  if (!lead) return NextResponse.json({ error: "lead not found" }, { status: 404 });
  return NextResponse.json({ lead, calls });
}
