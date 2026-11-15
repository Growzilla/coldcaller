import { NextResponse } from "next/server";
import { activeSession, activeCall, getDb, type CallRow } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Session + call only (no balance / queue): the cockpit polls this so Hang up and call status never
 *  depend on the SSE stream alone — a stalled stream left the page blind to a live line (2026-10-19).
 *  ?callId=N returns that call even once it has ended, so the page sees the hangup and goes to wrapup. */
export async function GET(req: Request) {
  const callId = Number(new URL(req.url).searchParams.get("callId")) || null;
  let call: (CallRow & { company?: string }) | null = activeCall() ?? null;
  if (!call && callId)
    call =
      (getDb()
        .prepare("SELECT c.*, l.company FROM calls c JOIN leads l ON l.id=c.lead_id WHERE c.id=?")
        .get(callId) as (CallRow & { company: string }) | undefined) ?? null;
  return NextResponse.json({ session: activeSession() ?? null, call });
}
