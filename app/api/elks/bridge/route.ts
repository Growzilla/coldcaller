import { NextResponse } from "next/server";
import { isSignedWebhook } from "@/lib/elks";

export const dynamic = "force-dynamic";

/**
 * 46elks "next" webhook after the operator answers and hears a beep —
 * returns the connect action that bridges the lead leg.
 */
export async function POST(req: Request) {
  if (!isSignedWebhook(req)) return NextResponse.json({ hangup: "reject" }, { status: 403 });
  const url = new URL(req.url);
  const lead = url.searchParams.get("lead");
  const callerid = url.searchParams.get("callerid");
  if (!lead) return NextResponse.json({ hangup: "reject" });
  return NextResponse.json({
    connect: lead,
    ...(callerid ? { callerid } : {}),
  });
}

export async function GET(req: Request) {
  return POST(req);
}