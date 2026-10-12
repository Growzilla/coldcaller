/**
 * Apply upload-CSV rows to existing GHL contacts over the API — for the rows GHL's CSV import
 * rejected ("Could not read the phone number": the contact carries a number libphonenumber calls
 * invalid, so the import can't match it). Same result as the CSV row: names, email, website,
 * address, custom fields (by field name), and the tags added.
 *
 *   npm run review:apply-rows -- ~/dev/ops/leads-engine/crm/ghl_phone_invalid.json [--live]
 *
 * ≈ 1 PUT per contact + 1 tag call per contact + the phone→contact listing. Stops cleanly on the
 * daily quota; re-running skips rows already applied (meta 'ghl_apply_rows_done').
 */
import fs from "fs";
import { config } from "../lib/config";
import { getDb } from "../lib/db";
import { QuotaExhausted, ghl, refreshPhoneMap } from "../lib/review-ghl";
import { reviewDb } from "../lib/review";

const STANDARD: Record<string, string> = {
  "Business Name": "companyName",
  "First Name": "firstName",
  "Last Name": "lastName",
  Email: "email",
  Website: "website",
  Address: "address1",
  City: "city",
  State: "state",
  "Postal Code": "postalCode",
  Country: "country",
  Source: "source",
};
const CLEAR_WHEN_EMPTY = new Set(["Email", "Website", "Website Found"]); // same as the CSV import (skip-empty off)

const file = process.argv[2];
const live = process.argv.includes("--live");
if (!file) throw new Error("usage: review:apply-rows <ghl_phone_invalid.json> [--live]");
const rows = (JSON.parse(fs.readFileSync(file, "utf8")).update_rows_needing_api ?? []) as Record<string, string>[];

(async () => {
  reviewDb();
  const doneRow = getDb().prepare("SELECT value FROM meta WHERE key='ghl_apply_rows_done'").get() as { value: string } | undefined;
  const done = new Set<string>(doneRow ? JSON.parse(doneRow.value) : []);
  const todo = rows.filter((r) => !done.has(r.Phone));
  console.log(`${rows.length} rows, ${done.size} done, ${todo.length} left`);
  if (!live) {
    console.log("dry run — first row:", todo[0]);
    return;
  }
  const save = () =>
    getDb().prepare("INSERT INTO meta(key,value) VALUES('ghl_apply_rows_done',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify([...done]));
  try {
    const fields = (await ghl<{ customFields: { id: string; name: string }[] }>("GET", `/locations/${config.ghlLocationId}/customFields?model=contact`)).customFields;
    const fieldId = new Map(fields.map((f) => [f.name.toLowerCase(), f.id]));
    console.log(`phone map: ${await refreshPhoneMap()} contacts`);
    const idOf = reviewDb().prepare("SELECT contact_id FROM ghl_phone_map WHERE phone=?");
    let missing = 0;
    for (const r of todo) {
      const id = (idOf.get(r.Phone) as { contact_id: string } | undefined)?.contact_id;
      if (!id) { missing++; continue; }
      const body: Record<string, unknown> = {};
      const customFields: { id: string; field_value: unknown }[] = [];
      for (const [col, val] of Object.entries(r)) {
        if (col === "Phone" || col === "Tags") continue;
        const empty = val === "" || val == null;
        if (empty && !CLEAR_WHEN_EMPTY.has(col)) continue;
        if (STANDARD[col]) body[STANDARD[col]] = empty ? null : val;
        else {
          const fid = fieldId.get(col.toLowerCase());
          if (fid) customFields.push({ id: fid, field_value: empty ? null : val });
        }
      }
      if (customFields.length) body.customFields = customFields;
      await ghl("PUT", `/contacts/${id}`, body);
      const tags = (r.Tags ?? "").split(",").filter(Boolean);
      if (tags.length) await ghl("POST", `/contacts/${id}/tags`, { tags });
      done.add(r.Phone);
      if (done.size % 50 === 0) { save(); console.log(`… ${done.size} applied`); }
    }
    save();
    console.log(`applied ${done.size}${missing ? `, ${missing} not found in GHL by phone` : ""}`);
  } catch (err) {
    save();
    if (err instanceof QuotaExhausted) console.log(`STOPPED: ${err.message} — re-run to continue (${done.size} done)`);
    else throw err;
  }
})();
