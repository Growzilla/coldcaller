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
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    globalThis.__dialerDb = db;
  }
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
      `SELECT * FROM leads WHERE status='queued' AND phone_e164 IS NOT NULL${countryWhere(country)}${sourceWhere(source)} ORDER BY priority, id LIMIT 1`
    )
    .get(...countryArgs(country), ...sourceArgs(source)) as Lead | undefined;
}

export function queuePreview(country?: string | null, source?: string | null, limit = 12): Lead[] {
  return getDb()
    .prepare(
      `SELECT * FROM leads WHERE status='queued' AND phone_e164 IS NOT NULL${countryWhere(country)}${sourceWhere(source)} ORDER BY priority, id LIMIT ?`
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

// ── Hermes read-access helpers (CRM-memory feed for the always-on agent) ─────────────
// Read-only queries over the existing SQLite so HermesAgent can see the queue, call
// outcomes + transcripts, and per-lead history. Used by the bearer-authed /api/leads/*
// and /api/calls/* read routes. No writes here.

export type RecentCall = CallRow & {
  company: string;
  first_name: string | null;
  last_name: string | null;
  phone_e164: string | null;
};

/** Recent calls joined with lead identity — Hermes's call-memory feed (outcome, duration,
 *  transcript, analysis). `sinceId` lets Hermes poll only what's new since its last read. */
export function recentCalls(limit = 50, sinceId = 0): RecentCall[] {
  const lim = Math.min(Math.max(limit, 1), 500);
  return getDb()
    .prepare(
      `SELECT c.*, l.company, l.first_name, l.last_name, l.phone_e164
       FROM calls c JOIN leads l ON l.id = c.lead_id
       WHERE c.id > ? ORDER BY c.id DESC LIMIT ?`
    )
    .all(sinceId, lim) as RecentCall[];
}

/** One lead plus its full call history — the "what happened to this prospect" view. */
export function leadTimeline(leadId: number): { lead: Lead | undefined; calls: CallRow[] } {
  const db = getDb();
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId) as Lead | undefined;
  const calls = lead
    ? (db.prepare("SELECT * FROM calls WHERE lead_id = ? ORDER BY id ASC").all(leadId) as CallRow[])
    : [];
  return { lead, calls };
}

/** Filtered lead list for Hermes — by status / country / source, newest first. */
export function listLeads(
  opts: { status?: string | null; country?: string | null; source?: string | null; limit?: number } = {}
): Lead[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.status) { where.push("status = ?"); args.push(opts.status); }
  if (opts.country) { where.push("country = ?"); args.push(opts.country); }
  if (opts.source) { where.push("source_file = ?"); args.push(opts.source); }
  const clause = where.length ? "WHERE " + where.join(" AND ") : "";
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  return getDb()
    .prepare(`SELECT * FROM leads ${clause} ORDER BY id DESC LIMIT ?`)
    .all(...args, limit) as Lead[];
}
