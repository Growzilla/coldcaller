import { getDb } from "./db";
import { config } from "./config";
import { publish } from "./bus";

/**
 * Booked-meeting detection. Dormant until CALENDLY_TOKEN is set
 * (free personal access token: calendly.com → Integrations → API & Webhooks).
 * Piggybacks on /api/state fetches — checks at most every 5 minutes, no timers.
 */
export async function checkBookings(): Promise<void> {
  if (!config.calendlyToken) return;
  const db = getDb();
  const last = db.prepare("SELECT value FROM meta WHERE key='calendly_last_check'").get() as
    | { value: string }
    | undefined;
  if (last && Date.now() - Number(last.value) < 5 * 60 * 1000) return;
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('calendly_last_check', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(String(Date.now()));

  try {
    const h = { Authorization: `Bearer ${config.calendlyToken}` };
    const me = await fetch("https://api.calendly.com/users/me", { headers: h }).then((r) => r.json());
    const userUri = me.resource?.uri;
    if (!userUri) return;

    const minStart = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const events = await fetch(
      `https://api.calendly.com/scheduled_events?user=${encodeURIComponent(userUri)}&min_start_time=${minStart}&status=active`,
      { headers: h }
    ).then((r) => r.json());

    for (const ev of events.collection ?? []) {
      const evKey = `calendly_ev_${ev.uri.split("/").pop()}`;
      if (db.prepare("SELECT 1 FROM meta WHERE key=?").get(evKey)) continue;

      const invitees = await fetch(`${ev.uri}/invitees`, { headers: h }).then((r) => r.json());
      for (const inv of invitees.collection ?? []) {
        const lead = db
          .prepare("SELECT id, company FROM leads WHERE email IS NOT NULL AND lower(email)=lower(?)")
          .get(inv.email) as { id: number; company: string } | undefined;
        if (!lead) continue;
        db.prepare("UPDATE leads SET prior_notes=COALESCE(prior_notes || char(10), '') || ? WHERE id=?").run(
          `🎉 MEETING BOOKED for ${ev.start_time}`,
          lead.id
        );
        publish({ type: "booked", payload: { lead_id: lead.id, company: lead.company, start: ev.start_time } });
      }
      db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(evKey, String(ev.start_time));
    }
  } catch {
    /* best-effort — next state fetch retries after the cooldown */
  }
}
