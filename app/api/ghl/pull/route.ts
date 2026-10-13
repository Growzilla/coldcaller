import { NextResponse } from "next/server";
import { ghlEnabled, pullQueue } from "@/lib/ghl";
import { queueCounts } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Pull this operator's dialable GHL opportunities into the local queue (coldcall runs this at boot). */
export async function POST() {
  if (!ghlEnabled()) return NextResponse.json({ error: "GHL sync off — set GHL_PRIVATE_TOKEN + GHL_LOCATION_ID" }, { status: 400 });
  try {
    const stats = await pullQueue();
    return NextResponse.json({ ok: true, ...stats, counts: queueCounts() });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "pull failed" }, { status: 502 });
  }
}
