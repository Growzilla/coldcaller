import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { leadClock, leadInCallWindow, leadTimeZone, openWindowLabel } from "./call-window";
import { config } from "./config";
import { DIALABLE_MOBILE_SQL } from "./phone";
import { ensureSmsSchema } from "./sms/schema";

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
  status TEXT DEFAULT 'queued',         -- queued | done | skipped | passed (passed = not needed, never re-queued)
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
  // snooze_until: "Later" in the cockpit hides a lead from the queue until then (it stays queued).
  const leadColsNow = (globalThis.__dialerDb.pragma("table_info(leads)") as { name: string }[]).map((c) => c.name);
  if (!leadColsNow.includes("snooze_until")) globalThis.__dialerDb.exec("ALTER TABLE leads ADD COLUMN snooze_until TEXT");
  // Google fit (lib/maps-fit.ts). maps_fit='suitable' is the only value the queue will dial
  // once meta queue_maps_only=1. Anything else was checked and failed, or not checked yet.
  for (const col of ["maps_fit TEXT", "maps_reason TEXT", "gbp_status TEXT", "maps_checked_at TEXT", "maps_rank INTEGER"]) {
    if (!leadColsNow.includes(col.split(" ")[0])) globalThis.__dialerDb.exec(`ALTER TABLE leads ADD COLUMN ${col}`);
  }
  ensureSmsSchema(globalThis.__dialerDb);
  // Depends on the clock, so not deterministic — SQLite must not cache it.
  globalThis.__dialerDb.function(
    "in_call_window",
    { deterministic: false },
    (city: string | null, country: string | null, notes: string | null) =>
      leadInCallWindow({ city, country, prior_notes: notes }) ? 1 : 0
  );
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
  maps_fit?: string | null;
  maps_reason?: string | null;
  gbp_status?: string | null;
  maps_rank?: number | null;
  /** "Perth 14:05" when the lead's zone is known. Not a column. */
  call_local?: string | null;
  /** True when call_local sits in 09:00–12:00 or 13:00–16:00. */
  call_open?: boolean;
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
const sourceWhere = (source?: string | null) =>
  source === REVENUE_1_5M_SOURCE ? REVENUE_1_5M_SQL : source ? " AND source_file=?" : "";
const sourceArgs = (source?: string | null) => (source && source !== REVENUE_1_5M_SOURCE ? [source] : []);
/** Virtual source: leads with 1–5 MSEK revenue, read from the "· oms 3.2 MSEK" text in prior_notes.
 *  Only batches that carry that text can match (today: se-electricians-v2-*). */
const REVENUE_1_5M_SOURCE = "oms:1-5MSEK";
const REVENUE_1_5M_SQL =
  " AND prior_notes LIKE '%· oms % MSEK%' AND CAST(substr(prior_notes, instr(prior_notes, '· oms ') + 6) AS REAL) BETWEEN 1 AND 5";
/** Queue gate: leads put off with "Later" stay hidden until their time. */
const gateWhere = () => " AND (snooze_until IS NULL OR snooze_until <= datetime('now'))";
/**
 * Google fit gate. Off until `npm run maps:fit -- --apply` has stamped the queue.
 * Callbacks (priority 0) stay, because those are people we already promised to call.
 * Every other lead must be maps_fit='suitable': not shown for "{trade} {city}".
 */
export function mapsOnly(): boolean {
  const row = getDb().prepare("SELECT value FROM meta WHERE key='queue_maps_only'").get() as { value: string } | undefined;
  return row?.value === "1";
}
const mapsGate = () => (mapsOnly() ? " AND (priority = 0 OR maps_fit = 'suitable')" : "");
/** Callbacks first, then no-Business-Profile small towns, then the rest of the cleared leads. */
const mapsRank = () => (mapsOnly() ? "CASE WHEN priority = 0 THEN -1 ELSE COALESCE(maps_rank, 9) END, " : "");
/** Swedish and Australian landlines stay out of the queue. Other countries pass through. */
const mobileWhere = () => ` AND ${DIALABLE_MOBILE_SQL}`;

/** Move queued SE/AU landlines (and short invalid mobiles) to status `landline`. Reversible. */
export function holdNonMobiles(): number {
  return getDb()
    .prepare(`UPDATE leads SET status='landline' WHERE status='queued' AND phone_e164 IS NOT NULL AND NOT ${DIALABLE_MOBILE_SQL}`)
    .run().changes;
}
/** "New leads first": never-dialed leads come up newest-import first. Already-called leads stay
 *  queued behind them. Off = the normal order, priority (callbacks and pins) on top. */
const queueOrder = () =>
  `${freshOnly() ? "EXISTS (SELECT 1 FROM calls c WHERE c.lead_id=leads.id), leads.created_at DESC, " : ""}${mapsRank()}priority, score DESC, id`;

const queueFilter = (country?: string | null, source?: string | null) =>
  `status='queued' AND phone_e164 IS NOT NULL${countryWhere(country)}${sourceWhere(source)}${gateWhere()}${mapsGate()}${mobileWhere()}`;

/**
 * While any dialable lead is inside 09–12 or 13–16 local, the queue is just those
 * (callbacks still jump it — they were promised). Outside every window the normal
 * queue returns, so an evening session is not an empty screen.
 * Memoized for a second: /api/state asks for the next lead, the preview, and the count together.
 */
let windowGateMemo: { key: string; at: number; sql: string } | null = null;
function windowGate(country?: string | null, source?: string | null): string {
  const key = `${country ?? ""}\0${source ?? ""}\0${mapsOnly() ? 1 : 0}`;
  const now = Date.now();
  if (windowGateMemo && windowGateMemo.key === key && now - windowGateMemo.at < 1000) return windowGateMemo.sql;
  const open = getDb()
    .prepare(
      `SELECT 1 AS ok FROM leads WHERE ${queueFilter(country, source)} AND priority != 0 AND in_call_window(city, country, prior_notes) = 1 LIMIT 1`
    )
    .get(...countryArgs(country), ...sourceArgs(source));
  const sql = open ? ` AND (priority = 0 OR in_call_window(city, country, prior_notes) = 1)` : "";
  windowGateMemo = { key, at: now, sql };
  return sql;
}

function stampClock<T extends Lead>(row: T): T {
  if (!leadTimeZone(row)) return row;
  return { ...row, call_local: leadClock(row), call_open: leadInCallWindow(row) };
}

export function freshOnly(): boolean {
  const row = getDb().prepare("SELECT value FROM meta WHERE key='queue_fresh_only'").get() as { value: string } | undefined;
  return row?.value === "1";
}

export function setFreshOnly(on: boolean) {
  getDb()
    .prepare("INSERT INTO meta (key, value) VALUES ('queue_fresh_only', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(on ? "1" : "0");
}

/** Put a lead off for `hours` — it drops out of the queue and comes back on its own afterwards. */
export function snoozeLead(id: number, hours: number) {
  getDb().prepare("UPDATE leads SET snooze_until=datetime('now', ?) WHERE id=?").run(`+${hours} hours`, id);
}

/** Remember the lead the operator just wrapped, so Undo restores that one even when no call row exists. */
export function rememberWrapup(leadId: number) {
  getDb()
    .prepare("INSERT INTO meta (key, value) VALUES ('last_wrapup_lead', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(String(leadId));
}

/** Lead id from the last wrapup, if any. Cleared so a second Undo falls through to the previous call. */
export function takeLastWrapup(): number | null {
  const db = getDb();
  const row = db.prepare("SELECT value FROM meta WHERE key='last_wrapup_lead'").get() as { value: string } | undefined;
  if (!row) return null;
  db.prepare("DELETE FROM meta WHERE key='last_wrapup_lead'").run();
  const id = Number(row.value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * "Not needed" — the operator looked at this lead and it is not one we can help.
 * Status `passed` is sticky: the queue, a GHL pull, and a call-log import will not bring it back.
 * Undo is the way to reverse a misclick.
 */
export function passLead(id: number) {
  getDb().prepare("UPDATE leads SET status='passed', snooze_until=NULL WHERE id=?").run(id);
  rememberWrapup(id);
}

export function nextLead(country?: string | null, source?: string | null): Lead | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM leads WHERE ${queueFilter(country, source)}${windowGate(country, source)} ORDER BY ${queueOrder()} LIMIT 1`)
    .get(...countryArgs(country), ...sourceArgs(source)) as Lead | undefined;
  return row ? stampClock(row) : undefined;
}

export function queuePreview(country?: string | null, source?: string | null, limit = 12): Lead[] {
  return (
    getDb()
      .prepare(`SELECT * FROM leads WHERE ${queueFilter(country, source)}${windowGate(country, source)} ORDER BY ${queueOrder()} LIMIT ?`)
      .all(...countryArgs(country), ...sourceArgs(source), limit) as Lead[]
  ).map(stampClock);
}

export function queueCounts(country?: string | null, source?: string | null) {
  const db = getDb();
  const gate = windowGate(country, source);
  return {
    queued: (db.prepare(`SELECT COUNT(*) c FROM leads WHERE ${queueFilter(country, source)}${gate}`).get(...countryArgs(country), ...sourceArgs(source)) as any).c,
    done: (db.prepare("SELECT COUNT(*) c FROM leads WHERE status='done'").get() as any).c,
    callsToday: (db.prepare("SELECT COUNT(*) c FROM calls WHERE date(started_at)=date('now')").get() as any).c,
    /** True once the Google fit gate is on. The cockpit uses it to explain a shorter queue. */
    mapsOnly: mapsOnly(),
    /** "Perth 14:05 · Darwin 15:35" while the queue is restricted to a calling block. Empty otherwise. */
    callWindow: gate ? openWindowLabel(country) : "",
    mapsHidden: mapsOnly()
      ? (db.prepare(`SELECT COUNT(*) c FROM leads WHERE status='queued' AND phone_e164 IS NOT NULL${countryWhere(country)}${sourceWhere(source)}${gateWhere()}${mobileWhere()} AND NOT (priority = 0 OR maps_fit = 'suitable')`).get(...countryArgs(country), ...sourceArgs(source)) as any).c
      : 0,
  };
}

/** Country breakdown of the dialable queue — feeds the cockpit region dropdown. */
export function countryBreakdown(): { country: string; n: number }[] {
  return getDb()
    .prepare(
      `SELECT country, COUNT(*) n FROM leads WHERE status='queued' AND phone_e164 IS NOT NULL AND country IS NOT NULL${mapsGate()}${mobileWhere()} GROUP BY country ORDER BY n DESC`
    )
    .all() as { country: string; n: number }[];
}

/** Source-file breakdown of the dialable queue, most-recent batch first (by max id).
 *  Feeds the cockpit "source" dropdown so you can isolate the latest import. */
export function sourceBreakdown(): { source: string; n: number }[] {
  const batches = getDb()
    .prepare(
      `SELECT source_file source, COUNT(*) n, MAX(id) latest FROM leads WHERE status='queued' AND phone_e164 IS NOT NULL AND source_file IS NOT NULL${mapsGate()}${mobileWhere()} GROUP BY source_file ORDER BY latest DESC`
    )
    .all() as { source: string; n: number }[];
  const revenue = getDb()
    .prepare(`SELECT COUNT(*) n FROM leads WHERE status='queued' AND phone_e164 IS NOT NULL${REVENUE_1_5M_SQL}${mapsGate()}${mobileWhere()}`)
    .get() as { n: number };
  return revenue.n > 0 ? [...batches, { source: REVENUE_1_5M_SOURCE, n: revenue.n }] : batches;
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

/** Inbound/sent SMS with the matching lead (by the other party's number) so the inbox can show the company. */
export function listInboundSms(limit = 20): (InboundSmsRow & {
  lead_id: number | null;
  lead_company: string | null;
  lead_name: string | null;
})[] {
  return getDb()
    .prepare(
      `SELECT s.*, l.id lead_id, l.company lead_company,
              NULLIF(TRIM(COALESCE(l.first_name,'') || ' ' || COALESCE(l.last_name,'')), '') lead_name
       FROM inbound_sms s
       LEFT JOIN leads l ON l.id = (
         SELECT id FROM leads
         WHERE phone_e164 = CASE WHEN s.from_e164 = ? THEN s.to_e164 ELSE s.from_e164 END
         ORDER BY id DESC LIMIT 1)
       ORDER BY s.received_at DESC LIMIT ?`
    )
    .all(config.elksNumber || "", limit) as (InboundSmsRow & {
    lead_id: number | null;
    lead_company: string | null;
    lead_name: string | null;
  })[];
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
