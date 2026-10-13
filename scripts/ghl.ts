/**
 * GHL sync CLI.
 *   npm run ghl -- check          token, pipeline + stages, sample of the queue (read-only)
 *   npm run ghl -- pull           GHL dialable opportunities → local queue
 *   npm run ghl -- push [--limit N] [--source FILE] [--status queued,done,parked] [--dry-run]
 *                                 seed GHL from local leads that have no GHL contact yet, placed by
 *                                 call history (callback → Callback, no answer → Attempted, …) with
 *                                 a history note + region/source tags; use once to migrate the
 *                                 existing dialer list so GHL becomes the master copy. Re-runnable:
 *                                 already-pushed leads (ghl_contact_id set) are skipped
 *   npm run ghl -- resync         retry calls whose GHL push failed (calls.ghl_error)
 */
import { config } from "../lib/config";
import { getDb, type Lead } from "../lib/db";
import { getPipeline, ghlEnabled, missingStages, pullQueue, seedLead, STAGES, syncCall } from "../lib/ghl";

const [cmd = "check", ...rest] = process.argv.slice(2);
const arg = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

async function main() {
  if (!ghlEnabled()) {
    console.error("✗ Set GHL_PRIVATE_TOKEN and GHL_LOCATION_ID in .env.local (see README → GoHighLevel)");
    process.exit(1);
  }

  if (cmd === "check") {
    const p = await getPipeline();
    console.log(`✓ token OK · location ${config.ghlLocationId}`);
    console.log(`✓ pipeline "${p.name}" (${p.id}): ${p.stages.map((s) => s.name).join(" → ")}`);
    const missing = await missingStages();
    if (missing.length) console.log(`⚠ missing stages (create in GHL, exact names): ${missing.join(", ")}`);
    else console.log("✓ all dialer stages present");
    console.log(config.ghlUserId ? `✓ queue filtered to GHL user ${config.ghlUserId}` : "⚠ GHL_USER_ID unset — pull takes EVERY user's leads");
    return;
  }

  if (cmd === "pull") {
    const s = await pullQueue();
    console.log(`✓ pulled ${s.fetched} opportunities: ${s.inserted} new, ${s.linked} linked to existing leads, ${s.requeued} re-queued, ${s.noPhone} without phone, ${s.nixHeld} sole traders held for NIX wash, ${s.scored} ICP-scored`);
    return;
  }

  if (cmd === "push") {
    const limit = Number(arg("limit") ?? 50);
    const source = arg("source");
    const statuses = (arg("status") ?? "queued,done").split(",").map((s) => s.trim()).filter(Boolean);
    const dry = rest.includes("--dry-run");
    const p = await getPipeline();
    const db = getDb();
    const leads = db
      .prepare(
        `SELECT * FROM leads WHERE ghl_contact_id IS NULL AND phone_e164 IS NOT NULL AND source_file != 'test'
           AND status IN (${statuses.map(() => "?").join(",")})${source ? " AND source_file=?" : ""}
         ORDER BY priority, id LIMIT ?`
      )
      .all(...statuses, ...(source ? [source] : []), limit) as Lead[];

    if (dry) {
      const lastOutcome = db.prepare("SELECT outcome FROM calls WHERE lead_id=? AND outcome IS NOT NULL ORDER BY id DESC LIMIT 1");
      const tally: Record<string, number> = {};
      for (const l of leads) {
        const o = (lastOutcome.get(l.id) as { outcome: string } | undefined)?.outcome ?? "never called";
        tally[o] = (tally[o] || 0) + 1;
      }
      console.log(`DRY RUN — would push ${leads.length} leads (status ${statuses.join("/")}) to "${p.name}", by last outcome:`, tally);
      return;
    }

    let ok = 0;
    const placed: Record<string, number> = {};
    for (const lead of leads) {
      try {
        const r = await seedLead(lead);
        const key = r.status === "open" ? r.stage : `${r.status} (${r.stage})`;
        placed[key] = (placed[key] || 0) + 1;
        ok++;
        if (ok % 25 === 0) console.log(`  … ${ok}/${leads.length}`);
        await new Promise((r) => setTimeout(r, 400)); // ~4 GHL calls per lead; stay under 100 req / 10 s
      } catch (err: any) {
        console.warn(`  ✗ lead ${lead.id} ${lead.company}: ${err?.message || err}`);
      }
    }
    console.log(`✓ pushed ${ok}/${leads.length} leads to GHL "${p.name}":`, placed);
    return;
  }

  if (cmd === "resync") {
    const rows = getDb().prepare("SELECT id FROM calls WHERE ghl_error IS NOT NULL AND outcome IS NOT NULL").all() as { id: number }[];
    for (const r of rows) await syncCall(r.id);
    const left = (getDb().prepare("SELECT COUNT(*) n FROM calls WHERE ghl_error IS NOT NULL").get() as { n: number }).n;
    console.log(`✓ retried ${rows.length} calls · ${left} still failing`);
    return;
  }

  console.error(`unknown command: ${cmd} (check | pull | push | resync)`);
  process.exit(1);
}

main().catch((err) => {
  console.error("✗", err?.message || err);
  process.exit(1);
});
