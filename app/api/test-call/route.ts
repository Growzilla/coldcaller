import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { dialLead, getDialerProvider, getOperatorPhone, runLineCheck } from "@/lib/dialer";

export const dynamic = "force-dynamic";

// Audio-path test: dials the operator's own number into the live room so you can
// answer it and confirm two-way audio works (isolates WebRTC/PSTN audio from leads).
const TEST_NUMBER = "+66838840280";
const TEST_COMPANY = "📞 TEST AUDIO";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    // 46elks bridge rings the operator mobile FIRST, so "bridging" to the operator's own number
    // just comes back busy. Instead ring the mobile and play a clip: answer → hear it = voice path OK.
    if (getDialerProvider() !== "vonage" && !body?.number) {
      const res = await runLineCheck();
      return NextResponse.json(
        res.ok ? { ok: true, to: getOperatorPhone(), detail: res.detail } : { error: res.detail },
        { status: res.ok ? 200 : 400 }
      );
    }
    const fallback =
      getDialerProvider() === "46elks" ? getOperatorPhone() || TEST_NUMBER : TEST_NUMBER;
    const number = (body?.number as string) || fallback; // optional override (used by the bridge harness)
    const db = getDb();
    // Idempotent test lead, kept OUT of the dialable queue (status='skipped', no country).
    db.prepare(
      `INSERT OR IGNORE INTO leads (first_name, last_name, company, phone_e164, source_file, priority, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("Audio", "Test", TEST_COMPANY, number, "test", 9, "skipped");
    const lead = db
      .prepare("SELECT * FROM leads WHERE company=? AND phone_e164=?")
      .get(TEST_COMPANY, number) as { id: number } | undefined;
    if (!lead) throw new Error("Could not create test lead");

    const callId = await dialLead(lead.id);
    // lead → the cockpit swaps its card to the test lead so the wrapup can't land on a real prospect.
    return NextResponse.json({ callId, to: number, lead });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Test call failed" }, { status: 400 });
  }
}
