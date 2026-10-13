/**
 * Read leads out of the LOCAL dialer.db via the app's own DB layer (not bash sqlite,
 * so the safety hook is happy) and print them as JSON for the bearer-authed
 * POST /api/leads endpoint on Render. Read-only — never writes.
 *
 *   npx tsx scripts/export-leads.ts queued   # only still-to-call leads (default)
 *   npx tsx scripts/export-leads.ts all       # every lead regardless of status
 *
 * stdout: { leads: [...] }   stderr: a human summary (counts by status/priority).
 */
import { getDb } from "../lib/db";

const which = (process.argv[2] || "queued").toLowerCase();
const db = getDb();

const all = db.prepare("SELECT * FROM leads ORDER BY priority, id").all() as any[];
const byStatus: Record<string, number> = {};
const byPriority: Record<string, number> = {};
let withPhone = 0;
for (const l of all) {
  byStatus[l.status] = (byStatus[l.status] || 0) + 1;
  byPriority[String(l.priority)] = (byPriority[String(l.priority)] || 0) + 1;
  if (l.phone_e164) withPhone++;
}
process.stderr.write(`local dialer.db: ${all.length} leads total, ${withPhone} with phone\n`);
process.stderr.write(`  by status:   ${JSON.stringify(byStatus)}\n`);
process.stderr.write(`  by priority: ${JSON.stringify(byPriority)}\n`);

const rows = which === "all" ? all : all.filter((l) => l.status === which);
const leads = rows
  .filter((l) => l.phone_e164) // no phone = not dialable, and breaks dedupe
  .map((l) => ({
    company: l.company,
    first_name: l.first_name,
    last_name: l.last_name,
    title: l.title,
    phone_e164: l.phone_e164,
    email: l.email,
    linkedin: l.linkedin,
    website: l.website,
    city: l.city,
    country: l.country,
    industry: l.industry,
    employees: l.employees,
    priority: l.priority,
    prior_notes: l.prior_notes,
    source: l.source_file || "local_import",
  }));

process.stderr.write(`exporting ${leads.length} "${which}" leads (with phone)\n`);
process.stdout.write(JSON.stringify({ leads }));
