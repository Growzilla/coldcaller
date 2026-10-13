import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { config } from "./config";

declare global {
  // eslint-disable-next-line no-var
  var __dialerDb: Database.Database | undefined;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT, last_name TEXT, title TEXT,
  company TEXT NOT NULL,
  phone_e164 TEXT,
  email TEXT, linkedin TEXT, website TEXT,
  city TEXT, country TEXT, industry TEXT, employees TEXT,
  source_file TEXT,
  priority INTEGER DEFAULT 2,           -- 0 callback-due, 1 high-value, 2 standard
  status TEXT DEFAULT 'queued',         -- queued | done | skipped
  prior_notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_leads_queue ON leads(status, priority, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_dedupe ON leads(company, phone_e164);

CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER REFERENCES leads(id),
  vonage_uuid TEXT,
  vonage_status TEXT,
  started_at TEXT DEFAULT (datetime('now')),
  answered_at TEXT, ended_at TEXT,
  duration_s INTEGER,
  outcome TEXT,                         -- no_answer | callback | interested | not_interested | bad_number
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_lead ON calls(lead_id);
CREATE INDEX IF NOT EXISTS idx_calls_uuid ON calls(vonage_uuid);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  leg_a_uuid TEXT,
  mode TEXT DEFAULT 'phone',            -- phone (PSTN leg A) | rtc (browser/WebRTC leg A)
  status TEXT DEFAULT 'starting',       -- starting | live | ended | failed
  started_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS inbound_sms (
  id TEXT PRIMARY KEY,
  from_e164 TEXT,
  to_e164 TEXT,
  message TEXT,
  created_at TEXT,
  received_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_inbound_sms_received ON inbound_sms(received_at DESC);
`;

export function getDb(): Database.Database {
  if (!globalThis.__dialerDb) {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    const db = new Database(config.dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
    // Migrations (columns added after initial deploy)
    const cols = (db.pragma("table_info(sessions)") as { name: string }[]).map((c) => c.name);
    if (!cols.includes("mode")) db.exec("ALTER TABLE sessions ADD COLUMN mode TEXT DEFAULT 'phone'");
    const callCols = (db.pragma("table_info(calls)") as { name: string }[]).map((c) => c.name);
    for (const col of ["recording_path TEXT", "transcript TEXT", "analysis TEXT"]) {
      if (!callCols.includes(col.split(" ")[0])) db.exec(`ALTER TABLE calls ADD COLUMN ${col}`);
    }
    // GHL sync (lib/ghl.ts): ids link a lead to its GHL contact/opportunity; per-call sync markers.
    const leadCols = (db.pragma("table_info(leads)") as { name: string }[]).map((c) => c.name);
    // score = ICP score from GHL (higher = better lead); NULL for legacy CSV leads → they sort last.
    for (const col of ["ghl_contact_id TEXT", "ghl_opportunity_id TEXT", "score REAL"]) {
      if (!leadCols.includes(col.split(" ")[0])) db.exec(`ALTER TABLE leads ADD COLUMN ${col}`);
    }
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_ghl_contact ON leads(ghl_contact_id)");
    for (const col of ["ghl_synced_at TEXT", "ghl_intel_synced_at TEXT", "ghl_error TEXT"]) {
      if (!callCols.includes(col.split(" ")[0])) db.exec(`ALTER TABLE calls ADD COLUMN ${col}`);
    }
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    db.exec(`
      CREATE TABLE IF NOT EXISTS inbound_sms (
        id TEXT PRIMARY KEY,
        from_e164 TEXT,
        to_e164 TEXT,
        message TEXT,
        created_at TEXT,
        received_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_inbound_sms_received ON inbound_sms(received_at DESC);
      CREATE TABLE IF NOT EXISTS inbound_verify (
        id TEXT PRIMARY KEY,
        callid TEXT,
        from_e164 TEXT,
        code TEXT,
        transcript TEXT,
        wav_path TEXT,
        received_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_inbound_verify_received ON inbound_verify(received_at DESC);
    `);
    globalThis.__dialerDb = db;
  }
  // Late migrations — must run even when __dialerDb already exists (hot reload).
  globalThis.__dialerDb.exec(`
    CREATE TABLE IF NOT EXISTS inbound_verify (
      id TEXT PRIMARY KEY,
      callid TEXT,
      from_e164 TEXT,
      code TEXT,
      transcript TEXT,
      wav_path TEXT,
      received_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_inbound_verify_received ON inbound_verify(received_at DESC);
  `);
  return globalThis.__dialerDb;
}

export type Lead = {
  id: number;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  company: string;
  phone_e164: string | null;
  email: string | null;
  linkedin: string | null;
  website: string | null;
  city: string | null;
  country: string | null;
  industry: string | null;
  employees: string | null;
  source_file: string | null;
  priority: number;
  status: string;
  prior_notes: string | null;
  ghl_contact_id?: string | null;
  ghl_opportunity_id?: string | null;
  score?: number | null;
};

export type CallRow = {
  id: number;
  lead_id: number;
  vonage_uuid: string | null;
  vonage_status: string | null;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_s: number | null;
  outcome: string | null;
  notes: string | null;
};

export type SessionRow = {
  id: number;
  leg_a_uuid: string | null;
  mode: string;
  status: string;
  started_at: string;
  ended_at: string | null;
};

/** Optional country filter ("United States", "Sweden", …) narrows the calling queue. */
const countryWhere = (country?: string | null) => (country ? " AND country=?" : "");
const countryArgs = (country?: string | null) => (country ? [country] : []);
/** Optional source filter (the import file a lead came from) — lets you dial one batch. */
const sourceWhere = (source?: string | null) => (source ? " AND source_file=?" : "");
const sourceArgs = (source?: string | null) => (source ? [source] : []);

export function nextLead(country?: string | null, source?: string | null): Lead | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM leads WHERE status='queued' AND phone_e164 IS NOT NULL${countryWhere(country)}${sourceWhere(source)} ORDER BY priority, score DESC, id LIMIT 1`
    )
    .get(...countryArgs(country), ...sourceArgs(source)) as Lead | undefined;
}

export function queuePreview(country?: string | null, source?: string | null, limit = 12): Lead[] {
  return getDb()
    .prepare(
      `SELECT * FROM leads WHERE status='queued' AND phone_e164 IS NOT NULL${countryWhere(country)}${sourceWhere(source)} ORDER BY priority, score DESC, id LIMIT ?`
    )
    .all(...countryArgs(country), ...sourceArgs(source), limit) as Lead[];
}

export function queueCounts(country?: string | null, source?: string | null) {
  const db = getDb();
  return {
    queued: (db.prepare(`SELECT COUNT(*) c FROM leads WHERE status='queued' AND phone_e164 IS NOT NULL${countryWhere(country)}${sourceWhere(source)}`).get(...countryArgs(country), ...sourceArgs(source)) as any).c,
    done: (db.prepare("SELECT COUNT(*) c FROM leads WHERE status='done'").get() as any).c,
    callsToday: (db.prepare("SELECT COUNT(*) c FROM calls WHERE date(started_at)=date('now')").get() as any).c,
  };
}

/** Country breakdown of the dialable queue — feeds the cockpit region dropdown. */
export function countryBreakdown(): { country: string; n: number }[] {
  return getDb()
    .prepare(
      "SELECT country, COUNT(*) n FROM leads WHERE status='queued' AND phone_e164 IS NOT NULL AND country IS NOT NULL GROUP BY country ORDER BY n DESC"
    )
    .all() as { country: string; n: number }[];
}

/** Source-file breakdown of the dialable queue, most-recent batch first (by max id).
 *  Feeds the cockpit "source" dropdown so you can isolate the latest import. */
export function sourceBreakdown(): { source: string; n: number }[] {
  return getDb()
    .prepare(
      "SELECT source_file source, COUNT(*) n, MAX(id) latest FROM leads WHERE status='queued' AND phone_e164 IS NOT NULL AND source_file IS NOT NULL GROUP BY source_file ORDER BY latest DESC"
    )
    .all() as { source: string; n: number }[];
}

export function activeSession(): SessionRow | undefined {
  return getDb()
    .prepare("SELECT * FROM sessions WHERE status IN ('starting','live') ORDER BY id DESC LIMIT 1")
    .get() as SessionRow | undefined;
}

/** Inbound caller-ID lookup — match the calling number against the lead list. */
export function leadByPhone(e164: string): Lead | undefined {
  return getDb()
    .prepare("SELECT * FROM leads WHERE phone_e164=? ORDER BY id DESC LIMIT 1")
    .get(e164) as Lead | undefined;
}

export type LeadCallStats = {
  calls: number;
  talk_s: number;
  last_at: string | null;
  last_outcome: string | null;
};

/** Call-history stats for one lead — feeds the inbound caller card. */
export function leadCallStats(leadId: number): LeadCallStats {
  return getDb()
    .prepare(
      `SELECT COUNT(*) calls, COALESCE(SUM(duration_s),0) talk_s, MAX(started_at) last_at,
        (SELECT outcome FROM calls WHERE lead_id=? AND outcome IS NOT NULL ORDER BY id DESC LIMIT 1) last_outcome
       FROM calls WHERE lead_id=?`
    )
    .get(leadId, leadId) as LeadCallStats;
}

export function activeCall(): (CallRow & { company: string }) | undefined {
  return getDb()
    .prepare(
      `SELECT c.*, l.company FROM calls c JOIN leads l ON l.id=c.lead_id
       WHERE c.ended_at IS NULL AND c.vonage_uuid IS NOT NULL ORDER BY c.id DESC LIMIT 1`
    )
    .get() as (CallRow & { company: string }) | undefined;
}

/**
 * Unended call rows that still count as "in progress" (one-call-at-a-time guard): placed legs
 * (have a provider id) plus dials whose create-call request hasn't returned yet (no id, started
 * < 90s ago — older id-less rows are crash leftovers).
 */
export function openCalls(): { id: number; vonage_uuid: string | null }[] {
  return getDb()
    .prepare(
      `SELECT id, vonage_uuid FROM calls WHERE ended_at IS NULL
         AND (vonage_uuid IS NOT NULL OR started_at > datetime('now', '-90 seconds'))
       ORDER BY id DESC`
    )
    .all() as { id: number; vonage_uuid: string | null }[];
}

export type InboundSmsRow = {
  id: string;
  from_e164: string | null;
  to_e164: string | null;
  message: string | null;
  created_at: string | null;
  received_at: string;
};

/** Store an inbound SMS from the 46elks webhook (idempotent on message id). */
export function insertInboundSms(row: {
  id: string;
  from_e164: string;
  to_e164: string;
  message: string;
  created_at?: string | null;
}): InboundSmsRow | undefined {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO inbound_sms (id, from_e164, to_e164, message, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(row.id, row.from_e164, row.to_e164, row.message, row.created_at ?? null);
  return db.prepare("SELECT * FROM inbound_sms WHERE id=?").get(row.id) as InboundSmsRow | undefined;
}

export function listInboundSms(limit = 20): InboundSmsRow[] {
  return getDb()
    .prepare("SELECT * FROM inbound_sms ORDER BY received_at DESC LIMIT ?")
    .all(limit) as InboundSmsRow[];
}

export type InboundVerifyRow = {
  id: string;
  callid: string | null;
  from_e164: string | null;
  code: string | null;
  transcript: string | null;
  wav_path: string | null;
  received_at: string;
};

export function insertInboundVerify(row: {
  id: string;
  callid: string;
  from_e164: string | null;
  code: string | null;
  transcript: string | null;
  wav_path?: string | null;
}): InboundVerifyRow | undefined {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO inbound_verify (id, callid, from_e164, code, transcript, wav_path)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(row.id, row.callid, row.from_e164, row.code, row.transcript, row.wav_path ?? null);
  return db.prepare("SELECT * FROM inbound_verify WHERE id=?").get(row.id) as InboundVerifyRow | undefined;
}

export function listInboundVerify(limit = 10): InboundVerifyRow[] {
  return getDb()
    .prepare("SELECT * FROM inbound_verify ORDER BY received_at DESC LIMIT ?")
    .all(limit) as InboundVerifyRow[];
}
