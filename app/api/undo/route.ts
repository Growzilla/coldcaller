import { NextResponse } from "next/server";
import { getDb, nextLead, queuePreview, queueCounts } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Undo the last wrapup: re-queue the most recently done/skipped lead and clear its last outcome. */
export async function POST(req: Request) {
  const db = getDb();
  const body = await req.json().catch(() => ({} as any));
  const country = body?.country ? String(body.country) : null;
  const source = body?.source ? String(body.source) : null;
  const last = db
    .prepare(
      `SELECT l.id AS lead_id, c.id AS call_id FROM leads l
       LEFT JOIN calls c ON c.id = (SELECT MAX(id) FROM calls WHERE lead_id = l.id AND outcome IS NOT NULL)
       WHERE l.status IN ('done','skipped')
       ORDER BY COALESCE(c.id, 0) DESC, l.id DESC LIMIT 1`
    )
    .get() as { lead_id: number; call_id: number | null } | undefined;
  if (!last) return NextResponse.json({ error: "Nothing to undo" }, { status: 400 });

  db.prepare("UPDATE leads SET status='queued' WHERE id=?").run(last.lead_id);
  if (last.call_id) db.prepare("UPDATE calls SET outcome=NULL, notes=NULL WHERE id=?").run(last.call_id);

  return NextResponse.json({
    undoneLeadId: last.lead_id,
    currentLead: nextLead(country, source) ?? null,
    queue: queuePreview(country, source),
    counts: queueCounts(country, source),
  });
}
