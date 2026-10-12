/**
 * Build the GHL upload from the reviewed + site-verified prospects (for GHL's own Contacts → Import,
 * which doesn't use the 10k/day API quota).
 *
 *   npm run review:csv            (run review:sites and review:rank first)
 *
 * Writes to ~/dev/ops/leads-engine/crm/:
 *   ghl_upload_new_<n>.csv     contacts not in GHL yet + an Outbound / New Lead opportunity each
 *   ghl_upload_update_<n>.csv  contacts already in GHL (match on phone): refined score/tier, verified
 *                              website, tags to ADD
 *   ghl_cleanup_<n>.json       contacts in GHL whose website/email on file isn't theirs — GHL import
 *                              can't blank a field, so these are cleared over the API (null) later
 *
 * Websites: only a site proven theirs (lib/site-verify) is written. Emails on the domain of someone
 * else's site are dropped. Sole traders' org numbers (personnummer) are never written.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { buildModel, allReviewed, correctedV2, reviewDb, siteState, tierOf, type Prospect } from "../lib/review";

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

type Ranked = { score: number; tier: string; tags: string[]; gbp: string; ownSite: string | null; email: string };

function rank(p: Prospect): Ranked {
  const chips: string[] = p.chips ? JSON.parse(p.chips) : [];
  const site = siteState(p);
  const ownSite = chips.includes("no-site") ? null : site.trusted ? p.site_url ?? null : null;
  const score = p.rank_score ?? correctedV2(p).v2;
  const tier = p.verdict === "good" ? "A" : p.verdict === "bad" ? "D" : tierOf(score);
  const tags = [`priority-${tier.toLowerCase()}`];
  if ((tier === "A" || tier === "B") && p.verdict !== "bad") tags.push("good-prospect");
  if ((p.years ?? 0) >= 20) tags.push("est-20y-plus");
  if (!p.metro) tags.push("small-town");
  if (!ownSite) tags.push("no-website");
  if (p.verdict) tags.push(`review-${p.verdict}`, ...chips.map((c) => `rv-${c}`));
  const gbp = chips.includes("has-gbp") ? "present" : chips.includes("no-gbp") ? "none" : "unknown";
  return { score, tier, tags, gbp, ownSite, email: p.email_suspect ? "" : p.email ?? "" };
}

function baseTags(p: Prospect, ownSite: string | null): string[] {
  const trades: string[] = p.trades ? JSON.parse(p.trades) : [];
  const t = ["swedish", "src-leads-engine", ownSite ? "poor-website" : "no-website"];
  if (p.sources.includes("north") && !p.sources.includes("export")) t.push("list-north");
  if (p.sources.includes("painter") && !p.sources.includes("export")) t.push("list-painters");
  if (p.company_type === "EF") t.push("nix-required");
  return [...t, ...[...new Set(trades.map((x) => `niche-${NICHE[x] ?? x}`))].sort()];
}

// ── new contacts: the 719 the API import never reached + reviewed/trade rows from the lists ──
const newCols = ["First Name", "Company Name", "Phone", "Email", "Website", "Address", "City", "Postal Code", "Country", "Source", "Tags",
  "Org Number", "Region", "Trades", "Years In Business", "Owner Led", "Website Status", "Website Found", "ICP Score", "ICP Tier", "GBP Status",
  "Lead Source", "Lifecycle", "Alt Phone", "Opportunity Name", "Pipeline", "Stage", "Opportunity Status", "Opportunity Owner"];
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
  const x = exportRows.get(p.phone) ?? {};
  const r = rank(p);
  newRows.push({
    "First Name": p.company, // whole company name: GHL splits a full name at the first space
    "Company Name": p.company,
    Phone: p.phone,
    Email: r.email,
    Website: r.ownSite ?? "",
    Address: p.street ?? "",
    City: (p.city ?? "").toLowerCase().replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase()),
    "Postal Code": p.postcode ?? "",
    Country: "SE",
    Source: "Leads engine",
    Tags: [...baseTags(p, r.ownSite), ...r.tags.filter((t) => t !== "no-website")].join(","),
    "Org Number": p.company_type === "EF" ? "" : p.org_number ?? "",
    Region: "SE",
    Trades: (p.trades ? (JSON.parse(p.trades) as string[]) : []).join(", "),
    "Years In Business": p.years ?? "",
    "Owner Led": x.owner_led === true ? "yes" : x.owner_led === false ? "no" : "unknown",
    "Website Status": r.ownSite ? "Weak site" : "No website",
    "Website Found": r.ownSite ?? "",
    "ICP Score": r.score,
    "ICP Tier": r.tier,
    "GBP Status": r.gbp,
    "Lead Source": inExport ? "leads-engine" : `leads-engine (${p.sources})`,
    Lifecycle: "Cold",
    "Alt Phone": p.alt_phone ?? "",
    "Opportunity Name": p.company,
    Pipeline: "Outbound",
    Stage: "New Lead",
    "Opportunity Status": "open",
    "Opportunity Owner": "Albert Elmgart",
  });
}
newRows.sort((a, b) => Number(b["ICP Score"]) - Number(a["ICP Score"]));

// ── contacts already in GHL ──
const updCols = ["Phone", "Email", "Website", "Website Status", "Website Found", "ICP Score", "ICP Tier", "GBP Status", "Tags"];
const updRows: Record<string, unknown>[] = [];
const cleanup: { phone: string; company: string; clear: string[]; wrong_site: string | null; reason: string }[] = [];
for (const [phone, x] of exportRows) {
  if (notInGhl.has(phone)) continue;
  const p = byPhone.get(phone);
  if (!p) continue;
  const r = rank(p);
  updRows.push({
    Phone: phone,
    Email: r.email,
    Website: r.ownSite ?? "",
    "Website Status": r.ownSite ? "Weak site" : "No website",
    "Website Found": r.ownSite ?? "",
    "ICP Score": r.score,
    "ICP Tier": r.tier,
    "GBP Status": r.gbp,
    Tags: r.tags.join(","),
  });
  // what the first import wrote that is wrong and an import can't blank
  const clear: string[] = [];
  const listed = x.website as string | undefined;
  if (listed && (!r.ownSite || !r.ownSite.includes(listed.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]))) clear.push("website", "website_found");
  if (p.email_suspect && x.email) clear.push("email");
  if (clear.length) cleanup.push({ phone, company: p.company, clear, wrong_site: listed ?? null, reason: p.site_evidence ?? "" });
}
updRows.sort((a, b) => Number(b["ICP Score"]) - Number(a["ICP Score"]));

const newFile = path.join(OUT, `ghl_upload_new_${newRows.length}.csv`);
const updFile = path.join(OUT, `ghl_upload_update_${updRows.length}.csv`);
const cleanFile = path.join(OUT, `ghl_cleanup_${cleanup.length}.json`);
write(newFile, newCols, newRows);
write(updFile, updCols, updRows);
fs.writeFileSync(cleanFile, JSON.stringify(cleanup, null, 1), { mode: 0o600 });

const tierCount = (rows: Record<string, unknown>[]) => rows.reduce<Record<string, number>>((m, r) => ((m[String(r["ICP Tier"])] = (m[String(r["ICP Tier"])] ?? 0) + 1), m), {});
console.log(`new:     ${newRows.length} → ${newFile}  tiers ${JSON.stringify(tierCount(newRows))}`);
console.log(`         (lists: ${listSkipped.bad} DQ'd and ${listSkipped.notTrade} non-trade rows left out)`);
console.log(`update:  ${updRows.length} → ${updFile}  tiers ${JSON.stringify(tierCount(updRows))}`);
console.log(`cleanup: ${cleanup.length} GHL contacts carry a website/email that isn't theirs → ${cleanFile}`);
const m = buildModel(allReviewed());
console.log(`model: ${m.good} good · ${m.maybe} maybe · ${m.bad} bad`);
