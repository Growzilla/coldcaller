import { NextResponse } from "next/server";
import { dialLead } from "@/lib/vonage";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { leadId } = await req.json();
    if (!leadId) return NextResponse.json({ error: "leadId required" }, { status: 400 });
    const callId = await dialLead(Number(leadId));
    return NextResponse.json({ callId });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Failed to dial" }, { status: 400 });
  }
}
