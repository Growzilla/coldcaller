/**
 * M5 — Export today's dialer outcomes to the shared call log.
 *
 *   npm run export-log              # today
 *   npm run export-log -- 2026-06-04
 *
 * APPEND-ONLY into growzillaAssets/sales/leads/CALL-LOG-YYYY-MM-DD.md,
 * matching the existing bucket format so absorb/import flows keep working.
 */
import fs from "fs";
import path from "path";
import { getDb } from "../lib/db";

const LEADS_DIR = "/home/god0fm0ney/dev/growzillaAssets/sales/leads";

const BUCKETS: Record<string, string> = {
  callback: "🔁 Call back (timing)",
  no_answer: "📵 No answer — retry",
  interested: "✅ Interested",
  not_interested: "✖️ Disqualified",
  bad_number: "🚫 Bad number",
};

const date = process.argv[2] || new Date().toISOString().slice(0, 10);
const db = getDb();

const rows = db
  .prepare(
    `SELECT c.outcome, c.notes, c.duration_s, l.company, l.first_name, l.last_name, l.phone_e164, l.email
     FROM calls c JOIN leads l ON l.id = c.lead_id
     WHERE date(c.started_at) = ? AND c.outcome IS NOT NULL
     ORDER BY c.id`
  )
  .all(date) as any[];

if (rows.length === 0) {
  console.log(`No logged outcomes for ${date} — nothing to export.`);
  process.exit(0);
}

const byBucket = new Map<string, any[]>();
for (const r of rows) {
  const b = BUCKETS[r.outcome] ?? r.outcome;
  if (!byBucket.has(b)) byBucket.set(b, []);
  byBucket.get(b)!.push(r);
}

const hhmm = new Date().toTimeString().slice(0, 5);
let out = `\n---\n\n# RapidDial export · ${date} ${hhmm}\n`;
for (const [bucket, entries] of byBucket) {
  out += `\n## ${bucket} (${entries.length})\n\n`;
  for (const e of entries) {
    const contact = `${e.first_name ?? ""} ${e.last_name ?? ""}`.trim() || "—";
    out += `- **${e.company}** — ${contact} · \`${e.phone_e164}\`${e.email ? ` · ${e.email}` : ""}\n`;
    if (e.duration_s) out += `  - talk time ${e.duration_s}s\n`;
    if (e.notes) out += `  - _note: "${String(e.notes).replace(/\n/g, " ")}"_\n`;
  }
}

const file = path.join(LEADS_DIR, `CALL-LOG-${date}.md`);
const existed = fs.existsSync(file);
fs.appendFileSync(file, existed ? out : `# Cold-Call Log — ${date}\n${out}`);
console.log(`${existed ? "Appended" : "Created"} ${file} (${rows.length} outcomes, ${byBucket.size} buckets)`);
