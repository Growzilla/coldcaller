import { NextResponse } from "next/server";
import { getDb, nextLead, queuePreview, queueCounts, passLead, rememberWrapup } from "@/lib/db";
import { syncCall } from "@/lib/ghl";

export const dynamic = "force-dynamic";

const OUTCOMES = new Set(["no_answer", "callback", "interested", "not_interested", "bad_number"]);

/**
 * Log the wrapup for a lead and advance the queue.
 * Body: { leadId, outcome?, notes?, skip?: boolean }
 *  - skip:true  → lead marked passed ("not needed"): leaves the queue and is not pulled back
 *  - otherwise  → outcome required; attached to the lead's latest call (or a
 *    standalone log row if no call was placed)
 */
export async function POST(req: Request) {
  const db = getDb();
  const body = await req.json();
  const leadId = Number(body.leadId);
  if (!leadId) return NextResponse.json({ error: "leadId required" }, { status: 400 });

  if (body.skip) {
    passLead(leadId);
  } else {
    const outcome = String(body.outcome || "");
    if (!OUTCOMES.has(outcome))
      return NextResponse.json({ error: `outcome must be one of: ${[...OUTCOMES].join(", ")}` }, { status: 400 });
    const notes = body.notes ? String(body.notes) : null;

    const latest = db
      .prepare("SELECT id FROM calls WHERE lead_id=? ORDER BY id DESC LIMIT 1")
      .get(leadId) as { id: number } | undefined;
    let callId: number;
    if (latest) {
      // A call still in progress (same test as openCalls) stays open: the operator can log it and
      // move on, then hang it up from the next lead's card. Hang up / the poller close it.
      db.prepare(
        `UPDATE calls SET outcome=?, notes=?,
           ended_at=CASE WHEN ended_at IS NULL AND (vonage_uuid IS NOT NULL OR started_at > datetime('now', '-90 seconds'))
                         THEN NULL ELSE COALESCE(ended_at, datetime('now')) END
         WHERE id=?`
      ).run(outcome, notes, latest.id);
      callId = latest.id;
    } else {
      callId = Number(
        db.prepare("INSERT INTO calls (lead_id, outcome, notes, ended_at) VALUES (?,?,?,datetime('now'))")
          .run(leadId, outcome, notes).lastInsertRowid
      );
    }
    db.prepare("UPDATE leads SET status='done' WHERE id=?").run(leadId);
    rememberWrapup(leadId);
    void syncCall(callId); // GHL push — fire-and-forget, never blocks the next lead
  }

  const country = body.country ? String(body.country) : null;
  const source = body.source ? String(body.source) : null;
  return NextResponse.json({
    currentLead: nextLead(country, source) ?? null,
    queue: queuePreview(country, source),
    counts: queueCounts(country, source),
  });
}
