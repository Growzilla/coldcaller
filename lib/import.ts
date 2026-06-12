import path from "path";
import { parse } from "csv-parse/sync";
import { getDb } from "./db";
import { toE164 } from "./phone";

// Direct-dial columns in preference order — a real person's line.
const DIRECT_COLS = ["direct_dial", "best_dial", "mobile_or_best", "phone"];
// Switchboard / reception columns — only used as a last resort for LEGACY CSVs
// that carry no phone-quality signal. Apollo exports with a `phone_type` column
// must NOT fall back to these: a company line is not a decision-maker.
const COMPANY_COLS = ["company_phone", "org_phone"];

export type ImportStats = { rows: number; inserted: number; noPhone: number };

export function insertLeadStmt() {
  return getDb().prepare(`
    INSERT OR IGNORE INTO leads
      (first_name, last_name, title, company, phone_e164, email, linkedin, website,
       city, country, industry, employees, source_file, priority, prior_notes)
    VALUES
      (@first_name, @last_name, @title, @company, @phone_e164, @email, @linkedin, @website,
       @city, @country, @industry, @employees, @source_file, @priority, @prior_notes)
  `);
}

/** Import any Apollo-style CSV (schema auto-detected by column names). */
export function importCsvText(text: string, sourceName: string, priority = 2): ImportStats {
  const rows = parse(text, { columns: true, skip_empty_lines: true, relax_column_count: true });
  const insert = insertLeadStmt();
  let inserted = 0;
  let noPhone = 0;
  for (const r of rows as Record<string, string>[]) {
    const company = (r.company || "").trim();
    if (!company) continue;
    const region = ((r.country || "") + (r.region || "")).toLowerCase();
    const defaultCountry = /canada|united states|us\b|north/.test(region) ? "NA" : "SE";

    // Apollo-style CSVs carry a `phone_type` quality signal. When present, only a
    // `mobile` line is a true decision-maker direct dial — anything else (blank,
    // "other", a switchboard) is a company line and gets skipped, never queued.
    const phoneType = (r.phone_type || "").trim().toLowerCase();
    const hasQualitySignal = "phone_type" in r;
    if (hasQualitySignal && phoneType && phoneType !== "mobile") {
      noPhone++;
      continue;
    }

    let phone: string | null = null;
    for (const col of DIRECT_COLS) {
      phone = toE164(r[col], defaultCountry);
      if (phone) break;
    }
    // Switchboard fallback is allowed ONLY for legacy CSVs with no quality signal.
    if (!phone && !hasQualitySignal) {
      for (const col of COMPANY_COLS) {
        phone = toE164(r[col], defaultCountry);
        if (phone) break;
      }
    }
    if (!phone) {
      // No dialable direct number → not useful in a dialer queue (and NULL phones break dedupe).
      noPhone++;
      continue;
    }
    const res = insert.run({
      first_name: r.first_name || null,
      last_name: r.last_name || null,
      title: r.title || null,
      company,
      phone_e164: phone,
      email: r.email || null,
      linkedin: r.linkedin || null,
      website: r.website || null,
      city: r.city || null,
      country: r.country || null,
      industry: r.industry || null,
      employees: r.employees || null,
      source_file: path.basename(sourceName),
      priority,
      prior_notes: null,
    });
    inserted += res.changes;
  }
  return { rows: rows.length, inserted, noPhone };
}
