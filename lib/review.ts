import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import { getDb } from "./db";
import { toE164 } from "./phone";
import { hostOf } from "./site-verify";

/**
 * Lead review ("sourcing mode"): go through prospects WITHOUT calling, judge each one
 * good / maybe / bad, and let the verdicts teach the ranking. Prospects live in their own
 * `prospects` table (never in `leads`, so nothing here can enter the dial queue by itself).
 *
 * Sources (loaded by `npm run review:import`, idempotent, dedupe on phone):
 *   export  — leads-engine CRM export (the GHL import) joined with priority_v2.csv
 *   north   — north_diallist.csv (Norrland/Gävle/Linköping/Norrköping, not in GHL)
 *   painter — painter_leads(1).csv (målerifirmor, mostly no site, not in GHL)
 *
 * Privacy: sole traders' org numbers are personnummer — they are never stored here.
 */

export const VERDICTS = ["good", "maybe", "bad"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Reviewer labels (toggled with the keyboard). Pushed to GHL as rv-<key> tags. */
export const CHIPS: { key: string; hotkey: string; label: string }[] = [
  { key: "has-gbp", hotkey: "g", label: "Has GBP" },
  { key: "no-gbp", hotkey: "n", label: "No GBP" },
  { key: "no-site", hotkey: "e", label: "No site" },
  { key: "dead-site", hotkey: "d", label: "Dead/broken site" },
  { key: "old-site", hotkey: "o", label: "Old/dated site" },
  { key: "good-site", hotkey: "m", label: "Site is fine" },
  { key: "big-firm", hotkey: "b", label: "Too big" },
  { key: "wrong-niche", hotkey: "w", label: "Wrong niche" },
  { key: "not-active", hotkey: "x", label: "Looks inactive" },
];

export type Prospect = {
  id: number;
  phone: string;
  company: string;
  org_number: string | null;
  company_type: string | null;
  email: string | null;
  website: string | null;
  street: string | null;
  postcode: string | null;
  city: string | null;
  years: number | null;
  trades: string | null; // JSON array of leads-engine trade codes
  sni: string | null;
  sni_desc: string | null;
  presence: string; // none | dead | dated | template | weak
  evidence: string | null;
  metro: string;
  phone_is_mobile: number;
  alt_phone: string | null;
  description: string | null;
  v2: number;
  v2_reasons: string;
  sources: string;
  in_ghl: number;
  verdict: Verdict | null;
  chips: string | null; // JSON array of CHIPS keys
  note: string | null;
  reviewed_at: string | null;
  skipped_at: string | null;
  ghl_contact_id: string | null;
  ghl_synced_verdict: string | null;
  ghl_synced_at: string | null;
  ghl_error: string | null;
  // lib/site-verify (npm run review:sites)
  site_status?: string | null;
  site_url?: string | null;
  site_evidence?: string | null;
  email_suspect?: number | null;
  website_orig?: string | null;
  rank_score?: number | null;
  recheck?: number | null;
  prev_verdict?: string | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS prospects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL UNIQUE,
  company TEXT NOT NULL,
  org_number TEXT, company_type TEXT,
  email TEXT, website TEXT, street TEXT, postcode TEXT, city TEXT,
  years REAL, trades TEXT, sni TEXT, sni_desc TEXT,
  presence TEXT NOT NULL DEFAULT 'weak', evidence TEXT, metro TEXT NOT NULL DEFAULT '',
  phone_is_mobile INTEGER DEFAULT 0, alt_phone TEXT, description TEXT,
  v2 INTEGER NOT NULL DEFAULT 0, v2_reasons TEXT NOT NULL DEFAULT '',
  sources TEXT NOT NULL, in_ghl INTEGER NOT NULL DEFAULT 0,
  verdict TEXT, chips TEXT, note TEXT, reviewed_at TEXT, skipped_at TEXT,
  ghl_contact_id TEXT, ghl_synced_verdict TEXT, ghl_synced_at TEXT, ghl_error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prospects_verdict ON prospects(verdict, v2);
CREATE TABLE IF NOT EXISTS ghl_phone_map (phone TEXT PRIMARY KEY, contact_id TEXT NOT NULL, tags TEXT, fetched_at TEXT DEFAULT (datetime('now')));
`;

export function reviewDb() {
  const db = getDb();
  db.exec(SCHEMA);
  const cols = (db.pragma("table_info(prospects)") as { name: string }[]).map((c) => c.name);
  // rank_score = the dial order this review produces (see applyRanking); lib/ghl enrichScores prefers it
  if (!cols.includes("rank_score")) db.exec("ALTER TABLE prospects ADD COLUMN rank_score INTEGER");
  // lib/site-verify: is `website` really theirs? site_url = the URL we trust (null = none found)
  for (const col of ["site_status TEXT", "site_url TEXT", "site_evidence TEXT", "site_checked_at TEXT", "email_suspect INTEGER DEFAULT 0", "website_orig TEXT", "recheck INTEGER DEFAULT 0", "prev_verdict TEXT"]) {
    if (!cols.includes(col.split(" ")[0])) db.exec(`ALTER TABLE prospects ADD COLUMN ${col}`);
  }
  return db;
}

// ── Scoring (same rules as /opt/leads-engine/pipeline/priority_v2.py) ─────────

export function metroOf(postcode: string | null | undefined): string {
  const p = Number(String(postcode ?? "").replace(/\s/g, "")) || 0;
  if (p >= 10000 && p < 20000) return "stockholm";
  if (p >= 40000 && p < 44000) return "goteborg";
  if (p >= 20000 && p < 23000) return "malmo-lund";
  if (p >= 75000 && p < 76000) return "uppsala";
  return "";
}

/** Presence points for list sources that carry a visibility verdict instead of site flags. */
const PRESENCE_POINTS: Record<string, number> = { none: 35, dead: 35, dated: 28, template: 18, weak: 20 };

/** priority_v2 for rows without the export's site flags (north / painter lists). */
function scoreList(p: { years: number | null; presence: string; metro: string; sni: string | null }): { v2: number; reasons: string } {
  const why: string[] = [];
  let age = 15; // unknown age: neutral, not punished
  if (p.years == null) why.push("age ?");
  else {
    const y = p.years;
    age = y >= 30 ? 40 : y >= 20 ? 35 : y >= 15 ? 22 : y >= 10 ? 15 : y >= 5 ? 6 : 0;
    why.push(`${Math.floor(y)}y`);
  }
  const presence = PRESENCE_POINTS[p.presence] ?? 20;
  why.push(p.presence === "none" ? "no site" : `${p.presence} site`);
  const location = p.metro === "stockholm" ? 0 : p.metro ? 5 : 15;
  why.push(p.metro || "small town");
  const sni = (p.sni ?? "").trim();
  const trade = ["41", "42", "43"].includes(sni.slice(0, 2)) ? 10 : sni ? 0 : 6;
  if (!trade) why.push(`SNI ${sni}`);
  return { v2: age + presence + location + trade, reasons: why.join(", ") };
}

export function tierOf(v2: number): "A" | "B" | "C" | "D" {
  return v2 >= 75 ? "A" : v2 >= 60 ? "B" : v2 >= 45 ? "C" : "D";
}

// ── Import ────────────────────────────────────────────────────────────────

/** Legal-entity org number (10 digits, 3rd digit >= 2), or null for personnummer / junk. */
export function legalOrgNumber(raw: string | null | undefined): string | null {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("16")) d = d.slice(2);
  if (d.length !== 10) return null;
  return Number(d[2]) >= 2 ? d : null;
}

/** SNI 2007 → leads-engine trade code (same vocabulary as the export's `trades`). */
function tradesFromSni(sni: string): string[] {
  const s = sni.replace(/\D/g, "");
  if (!s) return [];
  if (s.startsWith("41")) return ["bygg"];
  if (s.startsWith("42") || s.startsWith("4311") || s.startsWith("4312") || s.startsWith("4313")) return ["mark"];
  if (s.startsWith("4321")) return ["el"];
  if (s.startsWith("43223")) return ["ventilation"];
  if (s.startsWith("4322")) return ["vvs"];
  if (s.startsWith("4329")) return ["isolering"];
  if (s.startsWith("4332")) return ["snickeri"];
  if (s.startsWith("4333")) return ["golv"];
  if (s.startsWith("43341")) return ["maleri"];
  if (s.startsWith("43342")) return ["glas"];
  if (s.startsWith("4391")) return ["tak"];
  if (s.startsWith("43")) return ["bygg"];
  return [];
}

type Row = Omit<Prospect, "id" | "verdict" | "chips" | "note" | "reviewed_at" | "skipped_at" | "ghl_contact_id" | "ghl_synced_verdict" | "ghl_synced_at" | "ghl_error">;

function readCsv(file: string): Record<string, string>[] {
  return parse(fs.readFileSync(file, "utf8"), { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true });
}

function fromExport(exportJsonl: string, priorityCsv: string): Row[] {
  const prio = new Map<string, Record<string, string>>();
  for (const r of readCsv(priorityCsv)) for (const p of r.phones.split(";")) if (p.trim()) prio.set(p.trim(), r);
  const out: Row[] = [];
  for (const line of fs.readFileSync(exportJsonl, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const x = JSON.parse(line);
    const phone = toE164(x.phone);
    if (!phone) continue;
    const p = prio.get(x.phone);
    const reasons: string = p?.reasons ?? "";
    out.push({
      phone,
      company: x.company,
      org_number: x.company_type === "EF" ? null : legalOrgNumber(x.org_number),
      company_type: x.company_type || null,
      email: x.email || null,
      website: x.website || null,
      street: x.street || null,
      postcode: x.postcode || null,
      city: x.city || null,
      years: typeof x.years === "number" ? x.years : null,
      trades: JSON.stringify(x.trades ?? []),
      sni: null,
      sni_desc: null,
      presence: !x.website || /no site/.test(reasons) ? "none" : "weak",
      evidence: reasons || null,
      metro: metroOf(x.postcode),
      phone_is_mobile: x.phone_is_mobile ? 1 : 0,
      alt_phone: x.alt_phone || null,
      description: x.description || null,
      v2: p ? Number(p.priority_v2) : 0,
      v2_reasons: reasons,
      sources: "export",
      in_ghl: 1,
    });
  }
  return out;
}

function fromNorth(file: string): Row[] {
  return readCsv(file).flatMap((r): Row[] => {
    const phone = toE164(r.phone || r.mobile || r.landline);
    if (!phone) return [];
    const org = legalOrgNumber(r.org_number);
    const presence = ["dead", "dated", "template"].includes(r.visibility) ? r.visibility : "weak";
    const metro = metroOf(r.postcode);
    const s = scoreList({ years: null, presence, metro, sni: r.sni || null });
    return [{
      phone,
      company: r.company_name,
      org_number: org,
      company_type: org ? "AB" : "EF",
      email: r.email || null,
      website: r.website || null,
      street: null,
      postcode: r.postcode || null,
      city: r.city || null,
      years: null,
      trades: JSON.stringify(tradesFromSni(r.sni || "")),
      sni: r.sni || null,
      sni_desc: r.sni_desc || null,
      presence,
      evidence: [r.site_platform, r.site_evidence].filter(Boolean).join(" · ") || null,
      metro,
      phone_is_mobile: r.mobile ? 1 : 0,
      alt_phone: r.landline && toE164(r.landline) !== phone ? toE164(r.landline) : null,
      description: null,
      v2: s.v2,
      v2_reasons: s.reasons,
      sources: "north",
      in_ghl: 0,
    }];
  });
}

function fromPainter(file: string): Row[] {
  return readCsv(file).flatMap((r): Row[] => {
    const phone = toE164(r.phone);
    if (!phone) return [];
    const org = legalOrgNumber(r.orgnr);
    const years = r.age_years ? Number(r.age_years) : null;
    const presence = r.website ? "weak" : "none";
    const metro = metroOf(r.postcode);
    const s = scoreList({ years, presence, metro, sni: "43341" });
    return [{
      phone,
      company: r.name,
      org_number: org,
      company_type: org ? "AB" : "EF",
      email: null,
      website: r.website || null,
      street: r.street || null,
      postcode: r.postcode || null,
      city: r.city || null,
      years,
      trades: JSON.stringify(["maleri"]),
      sni: "43341",
      sni_desc: "Måleriarbeten",
      presence,
      evidence: [r.verified, r.site_age_hint, r.directory_hit && `listed: ${r.directory_hit}`].filter(Boolean).join(" · ") || null,
      metro,
      phone_is_mobile: /^\+467/.test(phone) ? 1 : 0,
      alt_phone: null,
      description: r.desc || null,
      v2: s.v2,
      v2_reasons: s.reasons,
      sources: "painter",
      in_ghl: 0,
    }];
  });
}

export const DEFAULT_SOURCES = {
  exportJsonl: "/home/god0fm0ney/dev/ops/leads-engine/crm/crm_export_20261010.clean.jsonl",
  priorityCsv: "/home/god0fm0ney/dev/ops/leads-engine/crm/priority_v2.csv",
  north: "/home/god0fm0ney/dev/north_diallist.csv",
  painter: "/home/god0fm0ney/dev/painter_leads(1).csv",
};

/**
 * Load every source. A phone already present keeps its review; the export (= what's in GHL)
 * wins on data, other sources are appended to `sources` so overlaps stay visible.
 */
export function importProspects(src = DEFAULT_SOURCES): Record<string, { read: number; added: number; merged: number }> {
  const db = reviewDb();
  const stats: Record<string, { read: number; added: number; merged: number }> = {};
  const insert = db.prepare(`
    INSERT INTO prospects (phone, company, org_number, company_type, email, website, street, postcode, city, years,
      trades, sni, sni_desc, presence, evidence, metro, phone_is_mobile, alt_phone, description, v2, v2_reasons, sources, in_ghl)
    VALUES (@phone, @company, @org_number, @company_type, @email, @website, @street, @postcode, @city, @years,
      @trades, @sni, @sni_desc, @presence, @evidence, @metro, @phone_is_mobile, @alt_phone, @description, @v2, @v2_reasons, @sources, @in_ghl)
    ON CONFLICT(phone) DO NOTHING`);
  const refreshExport = db.prepare(`
    UPDATE prospects SET company=@company, org_number=@org_number, company_type=@company_type, email=@email, website=@website,
      street=@street, postcode=@postcode, city=@city, years=@years, trades=@trades, presence=@presence, evidence=@evidence,
      metro=@metro, phone_is_mobile=@phone_is_mobile, alt_phone=@alt_phone, description=@description, v2=@v2,
      v2_reasons=@v2_reasons, in_ghl=1 WHERE phone=@phone`);
  const addSource = db.prepare(
    "UPDATE prospects SET sources=sources || ',' || @sources WHERE phone=@phone AND ',' || sources || ',' NOT LIKE '%,' || @sources || ',%'"
  );
  const load = (name: string, rows: Row[]) => {
    const s = (stats[name] = { read: rows.length, added: 0, merged: 0 });
    db.transaction(() => {
      for (const r of rows) {
        if (insert.run(r).changes) s.added++;
        else {
          if (name === "export") refreshExport.run(r);
          s.merged += addSource.run({ phone: r.phone, sources: r.sources }).changes;
        }
      }
    })();
  };
  if (fs.existsSync(src.exportJsonl) && fs.existsSync(src.priorityCsv)) load("export", fromExport(src.exportJsonl, src.priorityCsv));
  if (fs.existsSync(src.north)) load("north", fromNorth(src.north));
  if (fs.existsSync(src.painter)) load("painter", fromPainter(src.painter));
  return stats;
}

// ── Learning: which traits do the "good" verdicts share? ──────────────────

function ageBucket(y: number | null): string {
  if (y == null) return "age ?";
  return y >= 30 ? "30+ y" : y >= 20 ? "20–29 y" : y >= 15 ? "15–19 y" : y >= 10 ? "10–14 y" : y >= 5 ? "5–9 y" : "<5 y";
}

const NICHE_LABEL: Record<string, string> = { mark: "markarbete", el_installator: "el", maleri: "måleri", brand: "brandskydd" };

/** Traits known BEFORE review — the model learns which of these predict a good verdict. */
/** Site verdict for scoring: the site flags (GTM, ©, pages) only describe them when the site is theirs. */
export function siteState(p: Prospect): { trusted: boolean; sameSite: boolean; label: string } {
  const st = p.site_status;
  if (!st) return { trusted: true, sameSite: true, label: p.presence }; // not checked yet
  const listed = hostOf(p.website_orig ?? p.website);
  const trusted = st === "verified" || st === "likely";
  const sameSite = trusted && !!p.site_url && hostOf(p.site_url) === listed;
  if (trusted) return { trusted, sameSite, label: sameSite ? p.presence : "found via email/review (unscored)" };
  if (st === "dead") return { trusted, sameSite, label: "dead" };
  if (st === "parked") return { trusted, sameSite, label: "parked" };
  return { trusted, sameSite, label: "none of their own" };
}

/**
 * priority_v2 re-scored with the verified site: a lead whose listed site turned out to be someone
 * else's has NO site of its own → full presence points (35); a site found via the email domain or
 * the reviewer hasn't been fingerprinted → neutral 25. Age / location / trade parts are unchanged.
 */
export function correctedV2(p: Prospect): { v2: number; reasons: string } {
  const s = siteState(p);
  if (s.sameSite) return { v2: p.v2, reasons: p.v2_reasons };
  const y = p.years;
  const age = y == null ? 15 : y >= 30 ? 40 : y >= 20 ? 35 : y >= 15 ? 22 : y >= 10 ? 15 : y >= 5 ? 6 : 0;
  const location = p.metro === "stockholm" ? 0 : p.metro ? 5 : 15;
  const sni = (p.sni ?? p.v2_reasons.match(/SNI (\d+)/)?.[1] ?? "").trim();
  const trade = sni ? (["41", "42", "43"].includes(sni.slice(0, 2)) ? 10 : 0) : p.sources.includes("export") ? 10 : 6;
  const presence = s.trusted ? 25 : 35;
  const why = [y == null ? "age ?" : `${Math.floor(y)}y`, s.trusted ? "real site found (unscored)" : `no own site (listed: ${s.label})`, p.metro || "small town"];
  if (!trade && sni) why.push(`SNI ${sni}`);
  return { v2: age + presence + location + trade, reasons: why.join(", ") };
}

export function features(p: Prospect): string[] {
  const site = siteState(p);
  const f = [
    `age: ${ageBucket(p.years)}`,
    `site: ${site.label}`,
    `area: ${p.metro || "small town"}`,
    `form: ${companyForm(p)}`,
    `email: ${p.email ? "yes" : "no"}`,
    `phone: ${p.phone_is_mobile ? "mobile" : "landline"}`,
  ];
  const trades: string[] = p.trades ? JSON.parse(p.trades) : [];
  f.push(`niche: ${trades.length ? NICHE_LABEL[trades[0]] ?? trades[0] : "other/unknown"}`);
  const r = site.sameSite ? p.v2_reasons.toLowerCase() : "";
  for (const [needle, label] of [["gtm", "GTM"], ["pixel", "Meta pixel"], ["quote form", "quote form"], ["booking", "booking"], ["old ©", "old ©"], ["tiny site", "tiny site"], ["pages", "20+ pages"]] as const) {
    if (r.includes(needle)) f.push(`site has: ${label}`);
  }
  if (site.sameSite && /©20(2[3-9])/.test(p.v2_reasons)) f.push("site has: recent ©");
  // registry purpose listing many unrelated activities (bemanning, städ, import…) = not a pure trade
  if (p.description && p.description.split(/[,.;]| och /).filter((x) => x.trim().length > 3).length >= 5) f.push("purpose: many activities");
  return f;
}

function companyForm(p: Prospect): string {
  const t = p.company_type ?? "";
  if (t === "EF") return "sole trader";
  if (t === "HB" || t === "KB" || /\b(handelsbolag|kommanditbolag|hb|kb)$/i.test(p.company.trim())) return "HB/KB";
  if (t === "AB" || /\b(ab|aktiebolag)\b/i.test(p.company)) return "AB";
  return "other";
}

export type Pattern = { feature: string; n: number; good: number; maybe: number; bad: number; goodRate: number; lift: number };

export type Model = {
  reviewed: number;
  good: number;
  maybe: number;
  bad: number;
  ready: boolean;
  patterns: Pattern[];
  chipStats: { chip: string; label: string; n: number; good: number; bad: number }[];
  /** P(good) for one prospect, 0..1 — only meaningful when ready. */
  predict: (p: Prospect) => number;
};

/** Smoothed naive Bayes over features(); maybe counts half good, half bad. */
export function buildModel(reviewed: Prospect[]): Model {
  const w = (v: Verdict | null) => (v === "good" ? 1 : v === "maybe" ? 0.5 : 0);
  let G = 0, B = 0;
  const g = new Map<string, number>(), b = new Map<string, number>();
  const counts = new Map<string, { n: number; good: number; maybe: number; bad: number }>();
  const chipCounts = new Map<string, { n: number; good: number; bad: number }>();
  for (const p of reviewed) {
    const wg = w(p.verdict), wb = 1 - wg;
    G += wg;
    B += wb;
    for (const f of features(p)) {
      g.set(f, (g.get(f) ?? 0) + wg);
      b.set(f, (b.get(f) ?? 0) + wb);
      const c = counts.get(f) ?? { n: 0, good: 0, maybe: 0, bad: 0 };
      c.n++;
      if (p.verdict) c[p.verdict]++;
      counts.set(f, c);
    }
    for (const k of p.chips ? (JSON.parse(p.chips) as string[]) : []) {
      const c = chipCounts.get(k) ?? { n: 0, good: 0, bad: 0 };
      c.n++;
      if (p.verdict === "good") c.good++;
      if (p.verdict === "bad") c.bad++;
      chipCounts.set(k, c);
    }
  }
  const lift = (f: string) => Math.log(((g.get(f) ?? 0) + 1) / (G + 2)) - Math.log(((b.get(f) ?? 0) + 1) / (B + 2));
  const prior = Math.log((G + 1) / (B + 1));
  const patterns = [...counts.entries()]
    .filter(([, c]) => c.n >= 3)
    .map(([feature, c]) => ({ feature, ...c, goodRate: (c.good + c.maybe / 2) / c.n, lift: lift(feature) }))
    .sort((x, y) => y.lift - x.lift);
  const label = new Map(CHIPS.map((c) => [c.key, c.label]));
  return {
    reviewed: reviewed.length,
    good: reviewed.filter((p) => p.verdict === "good").length,
    maybe: reviewed.filter((p) => p.verdict === "maybe").length,
    bad: reviewed.filter((p) => p.verdict === "bad").length,
    ready: G >= 8 && B >= 8,
    patterns,
    chipStats: [...chipCounts.entries()].map(([chip, c]) => ({ chip, label: label.get(chip) ?? chip, ...c })).sort((x, y) => y.n - x.n),
    predict: (p) => {
      const z = prior + features(p).reduce((s, f) => s + lift(f), 0);
      return 1 / (1 + Math.exp(-z));
    },
  };
}

// ── Queue ─────────────────────────────────────────────────────────────────

export type Order = "v2" | "learned";
export type Filter = { source?: string | null; ghl?: "in" | "out" | null };

function filterSql(f: Filter): { where: string; args: string[] } {
  const parts: string[] = [];
  const args: string[] = [];
  if (f.source) {
    parts.push("(',' || sources || ',') LIKE ?");
    args.push(`%,${f.source},%`);
  }
  if (f.ghl === "in") parts.push("in_ghl=1");
  if (f.ghl === "out") parts.push("in_ghl=0");
  return { where: parts.length ? " AND " + parts.join(" AND ") : "", args };
}

export function allReviewed(): Prospect[] {
  return reviewDb().prepare("SELECT * FROM prospects WHERE verdict IS NOT NULL ORDER BY reviewed_at").all() as Prospect[];
}

/** Unreviewed prospects best-first; skipped ones go to the back. */
export function queue(order: Order, f: Filter, model: Model, limit = 10): (Prospect & { fit: number | null })[] {
  const { where, args } = filterSql(f);
  const rows = reviewDb()
    .prepare(`SELECT * FROM prospects WHERE verdict IS NULL${where}`)
    .all(...args) as Prospect[];
  const learned = order === "learned" && model.ready;
  const scored = rows.map((p) => ({ ...p, fit: model.ready ? model.predict(p) : null }));
  scored.sort((a, b) => {
    const rc = Number(b.recheck ?? 0) - Number(a.recheck ?? 0); // verdicts given on the wrong website first
    if (rc) return rc;
    const sk = Number(!!a.skipped_at) - Number(!!b.skipped_at);
    if (sk) return sk;
    if (a.skipped_at && b.skipped_at) return a.skipped_at.localeCompare(b.skipped_at);
    if (learned && a.fit !== b.fit) return (b.fit ?? 0) - (a.fit ?? 0);
    return correctedV2(b).v2 - correctedV2(a).v2 || a.id - b.id;
  });
  return scored.slice(0, limit);
}

export function counts(f: Filter) {
  const { where, args } = filterSql(f);
  const db = reviewDb();
  const one = (sql: string) => (db.prepare(sql + where).get(...args) as { n: number }).n;
  return {
    total: one("SELECT COUNT(*) n FROM prospects WHERE 1=1"),
    left: one("SELECT COUNT(*) n FROM prospects WHERE verdict IS NULL"),
    today: one("SELECT COUNT(*) n FROM prospects WHERE date(reviewed_at)=date('now')"),
    unsynced: one("SELECT COUNT(*) n FROM prospects WHERE verdict IS NOT NULL AND (ghl_synced_verdict IS NOT verdict OR ghl_synced_at IS NULL OR ghl_synced_at < reviewed_at)"),
  };
}

export function sourceCounts(): { source: string; n: number }[] {
  const rows = reviewDb().prepare("SELECT sources FROM prospects").all() as { sources: string }[];
  const m = new Map<string, number>();
  for (const r of rows) for (const s of r.sources.split(",")) m.set(s, (m.get(s) ?? 0) + 1);
  return [...m.entries()].map(([source, n]) => ({ source, n }));
}

export function setVerdict(id: number, verdict: Verdict | null, chips: string[], note: string | null): void {
  const ok = new Set(CHIPS.map((c) => c.key));
  reviewDb()
    .prepare("UPDATE prospects SET verdict=?, chips=?, note=?, reviewed_at=CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END, skipped_at=NULL, recheck=0 WHERE id=?")
    .run(verdict, JSON.stringify(chips.filter((c) => ok.has(c))), note?.trim() || null, verdict, id);
}

export function skip(id: number): void {
  reviewDb().prepare("UPDATE prospects SET skipped_at=datetime('now') WHERE id=?").run(id);
}

export function lastReviewed(): Prospect | undefined {
  return reviewDb().prepare("SELECT * FROM prospects WHERE verdict IS NOT NULL ORDER BY reviewed_at DESC, id DESC LIMIT 1").get() as Prospect | undefined;
}

/** Score written to GHL's ICP Score field (the dialer orders by it): good above every unreviewed lead. */
export function reviewedScore(p: Prospect): number | null {
  if (p.verdict === "good") return 100 + p.v2;
  if (p.verdict === "bad") return 0;
  return null; // maybe: keep the v2 score
}

// ── Export for GHL import (prospects not in GHL yet) ─────────────────────

/**
 * Good + maybe prospects that aren't in GHL, in the leads-engine export format, so the backend
 * importer (`/ghl cli import --leads-engine <file> --live`) brings them in with the same clean
 * tags (swedish, niche-*, nix-required for sole traders). Run Sync afterwards to add review tags.
 */
export function writeImportFile(dir = path.join(process.cwd(), "data", "review")): { file: string; rows: number } {
  const rows = reviewDb()
    .prepare("SELECT * FROM prospects WHERE in_ghl=0 AND verdict IN ('good','maybe') AND ghl_contact_id IS NULL ORDER BY verdict='good' DESC, v2 DESC")
    .all() as Prospect[];
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const file = path.join(dir, `review_import_${stamp}.jsonl`);
  const lines = rows.map((p) => {
    const chips: string[] = p.chips ? JSON.parse(p.chips) : [];
    return JSON.stringify({
      org_number: p.company_type === "EF" ? "" : p.org_number ?? "",
      company: p.company,
      company_type: p.company_type ?? "",
      phone: p.phone,
      alt_phone: p.alt_phone ?? "",
      phone_is_mobile: !!p.phone_is_mobile,
      email: p.email_suspect ? "" : p.email ?? "",
      website: chips.includes("no-site") ? "" : p.site_status ? p.site_url ?? "" : p.presence === "dead" ? "" : p.website ?? "",
      website_status: chips.includes("no-site") || (p.site_status ? !p.site_url : p.presence === "none" || p.presence === "dead") ? "none" : "weak",
      street: p.street ?? "",
      postcode: p.postcode ?? "",
      city: p.city ?? "",
      region: "SE",
      trades: p.trades ? JSON.parse(p.trades) : [],
      years: p.years,
      owner_led: null,
      icp_score: reviewedScore(p) ?? p.v2,
      icp_tier: tierOf(p.v2),
      gbp_status: chips.includes("has-gbp") ? "present" : chips.includes("no-gbp") ? "none" : "unknown",
      description: p.description ?? p.sni_desc ?? "",
    });
  });
  fs.writeFileSync(file, lines.join("\n") + (lines.length ? "\n" : ""), { mode: 0o600 });
  return { file, rows: rows.length };
}

// ── Feedback from the dialer + the resulting dial order ──────────────────

/** Labels inferred from a wrapup note ("very clean site", "DQ not trade", "500+ reviews"…). */
function chipsFromNote(note: string): string[] {
  const n = note.toLowerCase();
  const out: string[] = [];
  if (/(clean|good|goo|great|new|fine)\b[^.]{0,12}(site|website)|(site|website)[^.]{0,12}(clean|new|good|goo)\b|clearly new/.test(n)) out.push("good-site");
  if (/(shitty|poor|old|dated|bad)[^.]{0,12}(site|website)|no online/.test(n)) out.push("old-site");
  if (/\bno (web)?site|no website|har ingen (hemsida|webb)/.test(n)) out.push("no-site");
  if (/not[^.]{0,8}trade|\bdq\b|not relevant/.test(n)) out.push("wrong-niche");
  if (/\d+\+? ?reviews/.test(n)) out.push("has-gbp");
  return out;
}

/**
 * Turn dialer wrapups on prospects into verdicts: callback / interested / booked = good; a
 * "bad number" WITH a note is how Albert disqualifies a lead from the cockpit (DQ, not trade,
 * clean site) = bad. A verdict given on /review is never overwritten.
 */
export function importCallFeedback(): { good: number; bad: number; kept: number } {
  const db = reviewDb();
  const rows = db
    .prepare(
      `SELECT l.phone_e164 phone, c.outcome, c.notes, c.started_at FROM calls c JOIN leads l ON l.id=c.lead_id
       WHERE c.outcome IS NOT NULL AND l.phone_e164 IS NOT NULL ORDER BY c.id`
    )
    .all() as { phone: string; outcome: string; notes: string | null; started_at: string }[];
  // every note on the lead, verdict from the latest call
  const byPhone = new Map<string, { outcome: string; notes: string[]; at: string }>();
  for (const r of rows) {
    const e = byPhone.get(r.phone) ?? { outcome: r.outcome, notes: [], at: r.started_at };
    e.outcome = r.outcome;
    e.at = r.started_at;
    if (r.notes?.trim()) e.notes.push(r.notes.trim());
    byPhone.set(r.phone, e);
  }
  const get = db.prepare("SELECT id, verdict, reviewed_at, note FROM prospects WHERE phone=?");
  const set = db.prepare("UPDATE prospects SET verdict=?, chips=?, note=?, reviewed_at=?, skipped_at=NULL WHERE id=?");
  const keepNote = db.prepare("UPDATE prospects SET chips=?, note=? WHERE id=? AND note IS NULL");
  const res = { good: 0, bad: 0, kept: 0 };
  db.transaction(() => {
    for (const [phone, e] of byPhone) {
      const p = get.get(phone) as { id: number; verdict: string | null; reviewed_at: string | null; note: string | null } | undefined;
      if (!p) continue;
      const note = e.notes.join(" / ");
      const v = ["callback", "interested", "booked"].includes(e.outcome) ? "good" : e.outcome === "bad_number" && note ? "bad" : null;
      if (!v) continue;
      // hand review wins when it's newer than the call — but keep what the call note says
      if (p.verdict && p.reviewed_at && p.reviewed_at > e.at) {
        if (!p.note && note) keepNote.run(JSON.stringify(chipsFromNote(note)), `📞 ${note}`.slice(0, 1000), p.id);
        res.kept++;
        continue;
      }
      set.run(v, JSON.stringify(chipsFromNote(note)), `📞 ${note}`.slice(0, 1000), e.at, p.id);
      res[v]++;
    }
  })();
  return res;
}

/**
 * Write the review's dial order: said-good first (100 + v2), said-bad out (0), everyone else
 * v2 nudged by what the verdicts have in common (±15 once the model is ready). Mirrors it onto
 * the local dialer queue: good leads go back in at priority 0, bad ones leave it.
 */
export function applyRanking(): { ranked: number; delta: boolean; requeuedGood: number; removedBad: number; model: Model } {
  const db = reviewDb();
  const model = buildModel(allReviewed());
  const all = db.prepare("SELECT * FROM prospects").all() as Prospect[];
  const setRank = db.prepare("UPDATE prospects SET rank_score=? WHERE id=?");
  const leadScore = db.prepare("UPDATE leads SET score=? WHERE phone_e164=?");
  const requeue = db.prepare("UPDATE leads SET status='queued', priority=0 WHERE phone_e164=? AND status IN ('done','queued') AND (status!='queued' OR priority!=0)");
  const drop = db.prepare("UPDATE leads SET status='review_bad' WHERE phone_e164=? AND status IN ('queued','done')");
  let requeuedGood = 0, removedBad = 0;
  db.transaction(() => {
    for (const p of all) {
      const fixed = reviewedScore(p);
      // corrected v2 (0–100) ± 15 from the learned pattern, kept in 1–99 so a said-good lead (100+) stays on top
      const nudged = correctedV2(p).v2 + (model.ready ? 30 * (model.predict(p) - 0.5) : 0);
      const rank = fixed ?? Math.max(1, Math.min(99, Math.round(nudged)));
      setRank.run(rank, p.id);
      leadScore.run(rank, p.phone);
      if (p.verdict === "good") requeuedGood += requeue.run(p.phone).changes;
      if (p.verdict === "bad") removedBad += drop.run(p.phone).changes;
    }
  })();
  return { ranked: all.length, delta: model.ready, requeuedGood, removedBad, model };
}

/**
 * Bad verdicts given while looking at a website that turned out NOT to be theirs ("not trade" on
 * claes.se = an IT consultant) go back in the queue for a second look, first in line. Wrap-ups from
 * the dialer (notes starting 📞) stay: those came with a phone call.
 */
export function flagWrongSiteVerdicts(): number {
  return reviewDb()
    .prepare(
      `UPDATE prospects SET prev_verdict=verdict, verdict=NULL, reviewed_at=NULL, recheck=1
       WHERE verdict='bad' AND site_status IN ('mismatch','name-only','other-business')
         AND (note IS NULL OR note NOT LIKE '📞%')`
    )
    .run().changes;
}
