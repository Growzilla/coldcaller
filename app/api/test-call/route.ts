import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { dialLead } from "@/lib/vonage";

export const dynamic = "force-dynamic";

// Audio-path test: dials the operator's own number into the live room so you can
// answer it and confirm two-way audio works (isolates WebRTC/PSTN audio from leads).
const TEST_NUMBER = "+66838840280";
const TEST_COMPANY = "📞 TEST AUDIO";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const number = (body?.number as string) || TEST_NUMBER; // optional override (used by the bridge harness)
    const db = getDb();
    // Idempotent test lead, kept OUT of the dialable queue (status='skipped', no country).
    db.prepare(
      `INSERT OR IGNORE INTO leads (first_name, last_name, company, phone_e164, source_file, priority, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("Audio", "Test", TEST_COMPANY, number, "test", 9, "skipped");
    const lead = db
      .prepare("SELECT id FROM leads WHERE company=? AND phone_e164=?")
      .get(TEST_COMPANY, number) as { id: number } | undefined;
    if (!lead) throw new Error("Could not create test lead");

    const callId = await dialLead(lead.id);
    return NextResponse.json({ callId, to: number });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Test call failed" }, { status: 400 });
  }
}
