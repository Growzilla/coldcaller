/**
 * Clear what the first leads-engine import wrote wrong on GHL contacts: a website (and the email
 * scraped from it) that belongs to someone else. GHL's CSV import can't blank a field, so this runs
 * over the API: Website/Website Found → null, Website Status → "No website", wrong email → null.
 * Also removes the old-style tags (swedish, niche-*, icp:*, …) from every existing contact — the
 * upload CSV gave them the new lib/lead-tags scheme.
 *
 *   npm run review:cleanup -- ~/dev/ops/leads-engine/crm/ghl_cleanup_<n>.json [--live]
 *
 * ≈ 1 request per contact + 1 per 100 for the tag + the phone→contact listing. Stops cleanly on the
 * daily quota; re-running skips contacts already cleaned (tracked in meta 'ghl_cleanup_done').
 */
import fs from "fs";
import { config } from "../lib/config";
import { getDb } from "../lib/db";
import { QuotaExhausted, ghl, refreshPhoneMap } from "../lib/review-ghl";
import { reviewDb } from "../lib/review";

const FIELD_WEBSITE_FOUND = "TWv0IlUzc7PyqAmLHFE3";
const FIELD_WEBSITE_STATUS = "C94ymQXL6ijHp7qZGrBH";

const file = process.argv[2];
const live = process.argv.includes("--live");
if (!file) throw new Error("usage: review:cleanup <ghl_cleanup.json> [--live]");
const plan = JSON.parse(fs.readFileSync(file, "utf8")) as { legacy_tags: string[]; contacts: { phone: string; company: string; clear: string[] }[] };
const items = plan.contacts;

(async () => {
  const db = reviewDb();
  const doneRow = getDb().prepare("SELECT value FROM meta WHERE key='ghl_cleanup_done'").get() as { value: string } | undefined;
  const done = new Set<string>(doneRow ? JSON.parse(doneRow.value) : []);
  const todo = items.filter((x) => !done.has(x.phone));
  console.log(`${items.length} contacts: old-style tags off all, ${items.filter((x) => x.clear.length).length} also get a wrong website/email blanked`);
  console.log(`${done.size} already done, ${todo.length} left · legacy tags: ${plan.legacy_tags.length}`);
  if (!live) {
    console.log("dry run — e.g.", todo.slice(0, 3));
    return;
  }
  const saveDone = () =>
    getDb().prepare("INSERT INTO meta(key,value) VALUES('ghl_cleanup_done',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify([...done]));
  try {
    console.log(`phone map: ${await refreshPhoneMap()} contacts`);
    const idOf = db.prepare("SELECT contact_id FROM ghl_phone_map WHERE phone=?");
    const ids: string[] = [];
    let missing = 0;
    for (const x of todo) {
      const id = (idOf.get(x.phone) as { contact_id: string } | undefined)?.contact_id;
      if (!id) { missing++; continue; }
      ids.push(id);
      if (!x.clear.length) { done.add(x.phone); continue; } // tags only — handled in bulk below
      const body: Record<string, unknown> = {};
      if (x.clear.includes("website")) {
        body.website = null;
        body.customFields = [
          { id: FIELD_WEBSITE_FOUND, field_value: null },
          { id: FIELD_WEBSITE_STATUS, field_value: "No website" },
        ];
      }
      if (x.clear.includes("email")) body.email = null;
      await ghl("PUT", `/contacts/${id}`, body);
      done.add(x.phone);
      if (done.size % 100 === 0) { saveDone(); console.log(`… ${done.size} cleaned`); }
    }
    for (let i = 0; i < ids.length; i += 100) {
      await ghl("POST", "/contacts/bulk/tags/update/remove", { locationId: config.ghlLocationId, contacts: ids.slice(i, i + 100), tags: plan.legacy_tags });
    }
    saveDone();
    console.log(`cleaned ${ids.length}${missing ? `, ${missing} not found in GHL (upload not done yet?)` : ""}`);
  } catch (err) {
    saveDone();
    if (err instanceof QuotaExhausted) console.log(`STOPPED: ${err.message} — re-run to continue (${done.size} done)`);
    else throw err;
  }
})();
