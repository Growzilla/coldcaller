import { NextResponse } from "next/server";
import { getDb, type Lead } from "@/lib/db";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * Mid-call booking link. Fired by the operator (B key) while talking to the lead —
 * a consented, transactional send, not cold email.
 */
export async function POST(req: Request) {
  const { leadId } = await req.json().catch(() => ({}));
  if (!leadId) return NextResponse.json({ error: "leadId required" }, { status: 400 });
  if (!config.resendApiKey) return NextResponse.json({ error: "RESEND_API_KEY missing" }, { status: 400 });

  const db = getDb();
  const lead = db.prepare("SELECT * FROM leads WHERE id=?").get(Number(leadId)) as Lead | undefined;
  if (!lead?.email) return NextResponse.json({ error: "Lead has no email" }, { status: 400 });

  const firstName = lead.first_name?.trim();
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: config.bookingFrom,
      to: [lead.email],
      subject: "Link to grab a time — Growzilla",
      text: `Hi${firstName ? ` ${firstName}` : ""},\n\nGreat speaking just now. Here's the link to grab a time that suits you:\n\n${config.bookingUrl}\n\nTalk soon,\nAlbert\nGrowzilla`,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return NextResponse.json({ error: `Resend ${res.status}: ${detail.slice(0, 200)}` }, { status: 502 });
  }

  const stamp = `📅 booking link sent ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`;
  db.prepare("UPDATE leads SET prior_notes=COALESCE(prior_notes || char(10), '') || ? WHERE id=?").run(stamp, lead.id);

  return NextResponse.json({ ok: true, to: lead.email });
}
