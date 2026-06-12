/**
 * Import leads into the dialer queue.
 *
 *   npm run import                     # Sweden ecom set (default)
 *   npm run import -- path/to/file.csv # any Apollo-style CSV (schema auto-detected)
 *
 * Sources handled:
 *  - Apollo CSVs (any of the sales/leads schemas — column names auto-detected)
 *  - CALL-LOG-*.md markdown logs → callbacks become priority-0 leads with prior notes
 */
import fs from "fs";
import path from "path";
import { getDb } from "../lib/db";
import { toE164 } from "../lib/phone";
import { importCsvText, insertLeadStmt, type ImportStats } from "../lib/import";

const LEADS_DIR = "/home/god0fm0ney/dev/growzillaAssets/sales/leads";

const DEFAULT_CSVS = [
  { file: path.join(LEADS_DIR, "HIGH-VALUE-CLEAN-20260404.csv"), priority: 1 },
  { file: path.join(LEADS_DIR, "apollo-leads-20260403-222846.csv"), priority: 2 },
];

const DEFAULT_CALL_LOGS = [
  path.join(LEADS_DIR, "CALL-LOG-2026-06-02.md"),
  path.join(LEADS_DIR, "CALL-LOG-2026-06-03.md"),
];

const db = getDb();
const insertLead = insertLeadStmt();

function importCsv(file: string, priority: number): ImportStats {
  return importCsvText(fs.readFileSync(file, "utf8"), file, priority);
}

/* ---------- CALL-LOG markdown parsing ---------- */

type LogEntry = { company: string; contact: string; phone: string | null; email: string | null; notes: string[] };

function parseCallLog(file: string): { bucket: string; entries: LogEntry[] }[] {
  const out: { bucket: string; entries: LogEntry[] }[] = [];
  let current: { bucket: string; entries: LogEntry[] } | null = null;
  let entry: LogEntry | null = null;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const h = line.match(/^## (.+)$/);
    if (h) {
      current = { bucket: h[1].replace(/\s*\(\d+\)\s*$/, "").trim(), entries: [] };
      out.push(current);
      entry = null;
      continue;
    }
    const e = line.match(/^- \*\*(.+?)\*\*\s*—\s*(.+?)\s*·\s*`(.+?)`(?:\s*·\s*(\S+@\S+))?/);
    if (e && current) {
      entry = { company: e[1].trim(), contact: e[2].trim(), phone: e[3].trim(), email: e[4]?.trim() ?? null, notes: [] };
      current.entries.push(entry);
      continue;
    }
    const note = line.match(/^\s+- (.+)$/);
    if (note && entry) entry.notes.push(note[1].replace(/_/g, "").trim());
  }
  return out;
}

function bucketDisposition(bucket: string): "callback" | "skip" | "note" | "ignore" {
  const b = bucket.toLowerCase();
  if (/call tomorrow|call back|no answer/.test(b)) return "callback";
  if (/disqualified|email these/.test(b)) return "skip";
  if (/confirmed contact|intel/.test(b)) return "note";
  return "ignore";
}

function importCallLog(file: string): { callbacks: number; skipped: number; noted: number } {
  const stats = { callbacks: 0, skipped: 0, noted: 0 };
  const logDate = path.basename(file).replace(/CALL-LOG-|\.md/g, "");
  for (const { bucket, entries } of parseCallLog(file)) {
    const disp = bucketDisposition(bucket);
    if (disp === "ignore") continue;
    for (const e of entries) {
      const noteText = `[${logDate} · ${bucket}] ${e.notes.join(" | ")}`.trim();
      const existing = db
        .prepare("SELECT id, prior_notes FROM leads WHERE lower(company)=lower(?) ORDER BY id LIMIT 1")
        .get(e.company) as { id: number; prior_notes: string | null } | undefined;
      // Idempotent: re-running the import never duplicates a note line.
      const mergedNotes = (prev: string | null) =>
        prev ? (prev.includes(noteText) ? prev : `${prev}\n${noteText}`) : noteText;

      if (existing) {
        if (disp === "callback") {
          db.prepare("UPDATE leads SET priority=0, status='queued', prior_notes=? WHERE id=?")
            .run(mergedNotes(existing.prior_notes), existing.id);
          stats.callbacks++;
        } else if (disp === "skip") {
          db.prepare("UPDATE leads SET status='skipped', prior_notes=? WHERE id=?")
            .run(mergedNotes(existing.prior_notes), existing.id);
          stats.skipped++;
        } else {
          db.prepare("UPDATE leads SET prior_notes=? WHERE id=?").run(mergedNotes(existing.prior_notes), existing.id);
          stats.noted++;
        }
      } else if (disp === "callback") {
        // Callback due for a company not in any CSV — insert it directly from the log.
        const [first_name, ...rest] = e.contact.split(/\s+/);
        insertLead.run({
          first_name: first_name || null,
          last_name: rest.join(" ") || null,
          title: null,
          company: e.company,
          phone_e164: toE164(e.phone, "SE"),
          email: e.email,
          linkedin: null,
          website: null,
          city: null,
          country: "Sweden",
          industry: null,
          employees: null,
          source_file: path.basename(file),
          priority: 0,
          prior_notes: noteText,
        });
        stats.callbacks++;
      }
    }
  }
  return stats;
}

/* ---------- main ---------- */

const extraCsvs = process.argv.slice(2).filter((a) => a.endsWith(".csv"));

if (extraCsvs.length > 0) {
  for (const file of extraCsvs) {
    const r = importCsv(file, 2);
    console.log(`${path.basename(file)}: ${r.rows} rows → ${r.inserted} inserted (${r.noPhone} without phone)`);
  }
} else {
  for (const { file, priority } of DEFAULT_CSVS) {
    const r = importCsv(file, priority);
    console.log(`${path.basename(file)}: ${r.rows} rows → ${r.inserted} inserted (${r.noPhone} without phone)`);
  }
  for (const log of DEFAULT_CALL_LOGS) {
    const r = importCallLog(log);
    console.log(`${path.basename(log)}: ${r.callbacks} callbacks, ${r.skipped} skipped, ${r.noted} noted`);
  }
}

const c = db.prepare("SELECT status, COUNT(*) n FROM leads GROUP BY status").all();
const p = db.prepare("SELECT priority, COUNT(*) n FROM leads WHERE status='queued' AND phone_e164 IS NOT NULL GROUP BY priority").all();
console.log("status:", JSON.stringify(c), "| dialable by priority:", JSON.stringify(p));
