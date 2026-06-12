/**
 * Session digest — everything that happened today, with transcripts + action items.
 *
 *   npm run digest                # today
 *   npm run digest -- 2026-06-05
 *
 * Writes growzillaAssets/sales/leads/DIGEST-YYYY-MM-DD.md (append-only on rerun).
 * Also retries transcription for any recorded call that wasn't analyzed yet.
 */
import fs from "fs";
import path from "path";
import { getDb } from "../lib/db";
import { processCall } from "../lib/intelligence";

const LEADS_DIR = "/home/god0fm0ney/dev/growzillaAssets/sales/leads";
const date = process.argv[2] || new Date().toISOString().slice(0, 10);
const db = getDb();

type Row = {
  id: number;
  outcome: string | null;
  notes: string | null;
  duration_s: number | null;
  transcript: string | null;
  analysis: string | null;
  recording_path: string | null;
  company: string;
  first_name: string | null;
  last_name: string | null;
  phone_e164: string | null;
  email: string | null;
  prior_notes: string | null;
};

async function main() {
  // Catch-up pass: recorded but never analyzed (e.g. server restarted mid-pipeline)
  const pending = db
    .prepare("SELECT id FROM calls WHERE date(started_at)=? AND recording_path IS NOT NULL AND analysis IS NULL")
    .all(date) as { id: number }[];
  for (const p of pending) {
    process.stdout.write(`transcribing call ${p.id}…\n`);
    await processCall(p.id);
  }

  const rows = db
    .prepare(
      `SELECT c.id, c.outcome, c.notes, c.duration_s, c.transcript, c.analysis, c.recording_path,
              l.company, l.first_name, l.last_name, l.phone_e164, l.email, l.prior_notes
       FROM calls c JOIN leads l ON l.id=c.lead_id
       WHERE date(c.started_at)=? AND (c.outcome IS NOT NULL OR c.analysis IS NOT NULL)
       ORDER BY c.id`
    )
    .all(date) as Row[];
  if (rows.length === 0) {
    console.log(`No calls with outcomes on ${date}.`);
    return;
  }

  const parsed = rows.map((r) => ({ ...r, intel: safeJson(r.analysis) }));
  const actionItems = parsed.flatMap((r) =>
    (r.intel?.action_items ?? []).map((a: string) => `- [ ] **${r.company}** — ${a}`)
  );
  const booked = parsed.filter((r) => r.prior_notes?.includes("MEETING BOOKED"));
  const bookingSent = parsed.filter((r) => r.prior_notes?.includes("booking link sent"));
  const talk = parsed.reduce((s, r) => s + (r.duration_s ?? 0), 0);

  let md = `\n---\n\n# RapidDial digest · ${date} (generated ${new Date().toTimeString().slice(0, 5)})\n\n`;
  md += `**${parsed.length} calls** · ${Math.round(talk / 60)} min talk · ${bookingSent.length} booking links sent · ${booked.length} meetings booked\n\n`;
  if (actionItems.length) md += `## 🔥 Action items\n\n${actionItems.join("\n")}\n\n`;
  if (booked.length) md += `## 🎉 Booked\n\n${booked.map((r) => `- **${r.company}**`).join("\n")}\n\n`;

  md += `## Calls\n`;
  for (const r of parsed) {
    const contact = `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim();
    md += `\n### ${r.company}${r.intel?.interest != null ? ` · interest ${r.intel.interest}/5` : ""}\n`;
    md += `${[contact, r.phone_e164, r.email].filter(Boolean).join(" · ")}\n`;
    md += `- outcome: **${r.outcome ?? "—"}**${r.duration_s ? ` · ${r.duration_s}s` : ""}\n`;
    if (r.notes) md += `- my note: ${r.notes}\n`;
    if (r.intel?.summary) md += `- summary: ${r.intel.summary}\n`;
    if (r.intel?.objections?.length) md += `- objections: ${r.intel.objections.join("; ")}\n`;
    if (r.intel?.next_step) md += `- next step: ${r.intel.next_step}\n`;
    if (r.transcript) md += `<details><summary>transcript</summary>\n\n> ${r.transcript.replace(/\n/g, "\n> ")}\n\n</details>\n`;
  }

  const file = path.join(LEADS_DIR, `DIGEST-${date}.md`);
  const existed = fs.existsSync(file);
  fs.appendFileSync(file, existed ? md : `# RapidDial Digest — ${date}\n${md}`);
  console.log(`${existed ? "Appended to" : "Created"} ${file}`);
  console.log(`${parsed.length} calls · ${actionItems.length} action items · ${booked.length} booked`);
}

const safeJson = (s: string | null) => {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
};

main();
