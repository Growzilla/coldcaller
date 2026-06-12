import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { publish } from "@/lib/bus";

export const dynamic = "force-dynamic";

const FINAL = new Set(["completed", "failed", "rejected", "busy", "cancelled", "timeout", "unanswered"]);

/**
 * Vonage event webhook — when the tunnel is up this beats the 1s poller to status
 * changes; the poller remains the fallback so nothing depends on this being reachable.
 */
export async function POST(req: Request) {
  const e = await req.json().catch(() => null);
  if (!e?.uuid) return NextResponse.json({ ok: true });
  const db = getDb();
  const status = String(e.status ?? "");

  const call = db.prepare("SELECT id, vonage_status FROM calls WHERE vonage_uuid=?").get(e.uuid) as
    | { id: number; vonage_status: string | null }
    | undefined;
  if (call && status) {
    const updates = ["vonage_status=?"];
    const params: any[] = [status];
    if (status === "answered") updates.push("answered_at=COALESCE(answered_at, datetime('now'))");
    if (FINAL.has(status)) {
      updates.push("ended_at=COALESCE(ended_at, datetime('now'))");
      const dur = Number(e.duration);
      if (Number.isFinite(dur) && dur > 0) {
        updates.push("duration_s=?");
        params.push(dur);
      }
    }
    params.push(call.id);
    db.prepare(`UPDATE calls SET ${updates.join(", ")} WHERE id=?`).run(...params);
    if (status !== call.vonage_status)
      publish({ type: "call", payload: db.prepare("SELECT * FROM calls WHERE id=?").get(call.id) });
  }

  const session = db
    .prepare("SELECT id, status FROM sessions WHERE leg_a_uuid=? AND status IN ('starting','live')")
    .get(e.uuid) as { id: number; status: string } | undefined;
  if (session && FINAL.has(status)) {
    db.prepare("UPDATE sessions SET status='ended', ended_at=datetime('now') WHERE id=?").run(session.id);
    publish({ type: "session", payload: null });
  }

  return NextResponse.json({ ok: true });
}
