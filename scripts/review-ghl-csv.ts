/**
 * Build the GHL upload from the reviewed + site-verified prospects (for GHL's own Contacts → Import,
 * which doesn't use the 10k/day API quota).
 *
 *   npm run review:csv            (run review:sites and review:rank first)
 *
 * Writes to ~/dev/ops/leads-engine/crm/:
 *   GHL_1_update_existing_<n>.csv          contacts already in GHL (match on phone)
 *   GHL_2_new_with_opportunities_<n>.csv   contacts not in GHL yet + an Outbound / New Lead opportunity
 *   ghl_cleanup_<n>.json                   for the API afterwards: old-style tags to remove from every
 *                                          existing contact, and wrong website/email to blank (an import
 *                                          can't blank a field)
 *
 * Columns: Business Name, First/Last Name (the owner when clear), Email, Phone, Tags, then address,
 * custom fields. Tags follow lib/lead-tags.ts (country:se, region:, city:, niche:, years:, owner-led: …).
 *
 * Websites: only a site proven theirs (lib/site-verify) is written. Emails on the domain of someone
 * else's site are dropped. Sole traders' org numbers (personnummer) are never written.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { buildModel, allReviewed, correctedV2, reviewDb, siteState, tierOf, type Prospect } from "../lib/review";
import { NICHE_EN, contactPerson, swedishRegion, tagValue, yearsBucket, type Contact } from "../lib/lead-tags";

const OUT = path.join(os.homedir(), "dev/ops/leads-engine/crm");
const EXPORT = path.join(OUT, "crm_export_20261010.clean.jsonl");
const RETRY = path.join(OUT, "retry_20261013.jsonl");

const NICHE: Record<string, string> = {
  bygg: "bygg", snickeri: "snickeri", mark: "markarbete", el: "el", el_installator: "el", vvs: "vvs", maleri: "måleri",
  golv: "golv", ventilation: "ventilation", fasad: "fasad", tak: "tak", sten: "sten", isolering: "isolering", kyl: "kyl",
  brand: "brandskydd", glas: "glas", hiss: "hiss",
};

const db = reviewDb();
const all = db.prepare("SELECT * FROM prospects").all() as Prospect[];
const byPhone = new Map(all.map((p) => [p.phone, p]));
const unchecked = all.filter((p) => !p.site_status).length;
if (unchecked) {
  console.error(`${unchecked} prospects have no site check yet — run npm run review:sites first`);
  process.exit(1);
}
const exportRows = new Map<string, any>();
for (const l of fs.readFileSync(EXPORT, "utf8").split("\n")) if (l.trim()) { const x = JSON.parse(l); exportRows.set(x.phone, x); }
const notInGhl = new Set(fs.readFileSync(RETRY, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l).phone as string));

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const write = (file: string, cols: string[], rows: Record<string, unknown>[]) => {
  fs.writeFileSync(file, [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n", { mode: 0o600 });
};

type Ranked = { score: number; tier: string; gbp: string; ownSite: string | null; email: string; chips: string[] };

function rank(p: Prospect): Ranked {
  const chips: string[] = p.chips ? JSON.parse(p.chips) : [];
  const site = siteState(p);
  const ownSite = chips.includes("no-site") ? null : site.trusted ? p.site_url ?? null : null;
  const score = p.rank_score ?? correctedV2(p).v2;
  const tier = p.verdict === "good" ? "A" : p.verdict === "bad" ? "D" : tierOf(score);
  const gbp = chips.includes("has-gbp") ? "present" : chips.includes("no-gbp") ? "none" : "unknown";
  return { score, tier, gbp, ownSite, email: p.email_suspect ? "" : p.email ?? "", chips };
}

/** Full tag set in the lib/lead-tags scheme (the update replaces the old style, see LEGACY_TAGS). */
function tagsFor(p: Prospect, r: Ranked, ownerLed: boolean | null | undefined, contact: Contact | null): string[] {
  const trades: string[] = p.trades ? JSON.parse(p.trades) : [];
  const region = swedishRegion(p.postcode);
  const years = yearsBucket(p.years);
  const t = ["country:se", "lang:sv", "src:leads-engine"];
  if (region) t.push(`region:${tagValue(region)}`);
  if (p.city) t.push(`city:${tagValue(p.city)}`);
  t.push(...new Set(trades.map((x) => `niche:${NICHE_EN[x] ?? x}`)));
  if (years) t.push(`years:${years}`);
  // leads-engine infers owner-led from legal form + a person's name in the company name; "false"
  // only means it couldn't tell, so it's "unknown", never "no"
  t.push(`owner-led:${p.company_type === "EF" || ownerLed === true ? "yes" : "unknown"}`);
  t.push(`form:${p.company_type === "EF" ? "sole-trader" : p.company_type === "HB" || p.company_type === "KB" ? "partnership" : "company"}`);
  const st = p.site_status;
  t.push(`site:${r.ownSite ? "weak" : st === "dead" ? "dead" : st === "parked" ? "parked" : "none"}`);
  if (r.gbp !== "unknown") t.push(`gbp:${r.gbp}`);
  t.push(`priority:${r.tier.toLowerCase()}`);
  if ((r.tier === "A" || r.tier === "B") && p.verdict !== "bad") t.push("prospect:good");
  if (p.verdict) t.push(`review:${p.verdict}`, ...r.chips.map((c) => `rv:${c}`));
  t.push(`contact:${contact?.source ?? "unknown"}`);
  if (p.sources.includes("north") && !p.sources.includes("export")) t.push("list:north");
  if (p.sources.includes("painter") && !p.sources.includes("export")) t.push("list:painters");
  if (p.company_type === "EF") t.push("nix-required");
  return t;
}

/** Old-style tags from the first import — the cleanup step removes them once the upload is in. */
export const LEGACY_TAGS = [
  "swedish", "src-leads-engine", "poor-website", "no-website", "modern-website", "good-prospect", "est-20y-plus", "small-town",
  "icp:a-sell-now", "icp:b-strong", "icp:c-ok", "icp:d-low", "icp:a", "icp:b", "icp:c", "icp:d",
  "priority-a", "priority-b", "priority-c", "priority-d", "review-good", "review-maybe", "review-bad",
  "list-north", "list-painters", ...[...new Set(Object.values(NICHE))].map((n) => `niche-${n}`),
  ...["has-gbp", "no-gbp", "no-site", "dead-site", "old-site", "good-site", "big-firm", "wrong-niche", "not-active"].map((c) => `rv-${c}`),
];

const titleCity = (c: string | null) => (c ?? "").toLowerCase().replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase());

/** One contact row, standard column order: business, person, email, phone, tags, then the rest. */
function rowFor(p: Prospect, withOpportunity: boolean): Record<string, unknown> {
  const x = exportRows.get(p.phone) ?? {};
  const r = rank(p);
  const contact = contactPerson(p.company, r.email);
  const trades: string[] = p.trades ? JSON.parse(p.trades) : [];
  const row: Record<string, unknown> = {
    "Business Name": p.company,
    // no person known → the business name as first name, so the contact reads well everywhere in GHL
    "First Name": contact ? contact.first : p.company,
    "Last Name": contact ? contact.last : "",
    Email: r.email,
    Phone: p.phone,
    Tags: tagsFor(p, r, x.owner_led, contact).join(","),
    Website: r.ownSite ?? "",
    Address: p.street ?? "",
    City: titleCity(p.city),
    State: titleCity(swedishRegion(p.postcode)),
    "Postal Code": p.postcode ?? "",
    Country: "SE",
    Source: "Leads engine",
    "Org Number": p.company_type === "EF" ? "" : p.org_number ?? "",
    Region: "SE",
    Trades: trades.map((t) => NICHE_EN[t] ?? t).join(", "),
    "Years In Business": p.years ?? "",
    "Owner Led": p.company_type === "EF" || x.owner_led === true ? "yes" : "unknown",
    "Website Status": r.ownSite ? "Weak site" : "No website",
    "Website Found": r.ownSite ?? "",
    "ICP Score": r.score,
    "ICP Tier": r.tier,
    "GBP Status": r.gbp,
    "Lead Source": p.sources.includes("export") ? "leads-engine" : `leads-engine (${p.sources})`,
    Lifecycle: "Cold",
    "Alt Phone": p.alt_phone ?? "",
  };
  if (withOpportunity) {
    Object.assign(row, {
      "Opportunity Name": p.company,
      Pipeline: "Outbound",
      Stage: "New Lead",
      "Opportunity Status": "open",
      "Opportunity Owner": "Albert Elmgart",
    });
  }
  return row;
}

const baseCols = ["Business Name", "First Name", "Last Name", "Email", "Phone", "Tags", "Website", "Address", "City", "State", "Postal Code",
  "Country", "Source", "Org Number", "Region", "Trades", "Years In Business", "Owner Led", "Website Status", "Website Found", "ICP Score",
  "ICP Tier", "GBP Status", "Lead Source", "Lifecycle", "Alt Phone"];
const newCols = [...baseCols, "Opportunity Name", "Pipeline", "Stage", "Opportunity Status", "Opportunity Owner"];
const updCols = baseCols;

// ── new contacts: the 719 the API import never reached + reviewed/trade rows from the lists ──
const newRows: Record<string, unknown>[] = [];
const listSkipped = { bad: 0, notTrade: 0 };
for (const p of all) {
  const inExport = p.sources.includes("export");
  if (inExport && !notInGhl.has(p.phone)) continue; // already in GHL → update file
  if (!inExport) {
    // list rows: only real trades (or ones Albert judged), never his DQs
    const trades: string[] = p.trades ? JSON.parse(p.trades) : [];
    if (p.verdict === "bad") { listSkipped.bad++; continue; }
    if (!p.verdict && !trades.length) { listSkipped.notTrade++; continue; }
  }
  newRows.push(rowFor(p, true));
}
newRows.sort((a, b) => Number(b["ICP Score"]) - Number(a["ICP Score"]));

// ── contacts already in GHL (match on phone) ──
const updRows: Record<string, unknown>[] = [];
const cleanup: { phone: string; company: string; clear: string[]; wrong_site: string | null; reason: string }[] = [];
for (const [phone, x] of exportRows) {
  if (notInGhl.has(phone)) continue;
  const p = byPhone.get(phone);
  if (!p) continue;
  const row = rowFor(p, false);
  updRows.push(row);
  // what the first import wrote that is wrong and an import can't blank
  const clear: string[] = [];
  const own = String(row.Website || "");
  const listed = x.website as string | undefined;
  if (listed && (!own || !own.includes(listed.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]))) clear.push("website", "website_found");
  if (p.email_suspect && x.email) clear.push("email");
  cleanup.push({ phone, company: p.company, clear, wrong_site: clear.length ? listed ?? null : null, reason: clear.length ? p.site_evidence ?? "" : "" });
}
updRows.sort((a, b) => Number(b["ICP Score"]) - Number(a["ICP Score"]));

const newFile = path.join(OUT, `GHL_2_new_with_opportunities_${newRows.length}.csv`);
const updFile = path.join(OUT, `GHL_1_update_existing_${updRows.length}.csv`);
const cleanFile = path.join(OUT, `ghl_cleanup_${cleanup.length}.json`);
write(newFile, newCols, newRows);
write(updFile, updCols, updRows);
// every existing contact is in the cleanup: old-style tags come off all of them, wrong website/email off some
fs.writeFileSync(cleanFile, JSON.stringify({ legacy_tags: LEGACY_TAGS, contacts: cleanup }, null, 1), { mode: 0o600 });

const tierCount = (rows: Record<string, unknown>[]) => rows.reduce<Record<string, number>>((m, r) => ((m[String(r["ICP Tier"])] = (m[String(r["ICP Tier"])] ?? 0) + 1), m), {});
console.log(`new:     ${newRows.length} → ${newFile}  tiers ${JSON.stringify(tierCount(newRows))}`);
console.log(`         (lists: ${listSkipped.bad} DQ'd and ${listSkipped.notTrade} non-trade rows left out)`);
console.log(`update:  ${updRows.length} → ${updFile}  tiers ${JSON.stringify(tierCount(updRows))}`);
console.log(`cleanup: ${cleanup.length} existing contacts lose the old-style tags; ${cleanup.filter((c) => c.clear.length).length} also a website/email that isn't theirs → ${cleanFile}`);
const m = buildModel(allReviewed());
console.log(`model: ${m.good} good · ${m.maybe} maybe · ${m.bad} bad`);
