import { NextResponse } from "next/server";
import { dialLead } from "@/lib/dialer";
import { getDb, type Lead } from "@/lib/db";
import { toE164 } from "@/lib/phone";

export const dynamic = "force-dynamic";

/**
 * Find or create a minimal lead row for an ad-hoc dialed number. Reuses an existing
 * lead when the number is already known (so history/inbound matching stay linked);
 * otherwise inserts with status='done' so it never enters the queue rotation.
 */
function manualLead(e164: string): Lead {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM leads WHERE phone_e164=? ORDER BY id LIMIT 1").get(e164) as
    | Lead
    | undefined;
  if (existing) return existing;
  const country = e164.startsWith("+1") ? "United States" : e164.startsWith("+46") ? "Sweden" : null;
  const id = db
    .prepare("INSERT INTO leads (company, phone_e164, country, source_file, status) VALUES (?,?,?,?,'done')")
    .run("Manual dial", e164, country, "manual").lastInsertRowid as number;
  return db.prepare("SELECT * FROM leads WHERE id=?").get(id) as Lead;
}

export async function POST(req: Request) {
  try {
    const { leadId, number } = await req.json();
    if (number) {
      const e164 = toE164(String(number), "SE");
      if (!e164)
        return NextResponse.json(
          { error: "Couldn't parse that as a phone number — try +46…, +1…, or Swedish 07x…" },
          { status: 400 }
        );
      const lead = manualLead(e164);
      const callId = await dialLead(lead.id);
      return NextResponse.json({ callId, lead });
    }
    if (!leadId) return NextResponse.json({ error: "leadId or number required" }, { status: 400 });
    const callId = await dialLead(Number(leadId));
    return NextResponse.json({ callId });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Failed to dial" }, { status: 400 });
  }
}
