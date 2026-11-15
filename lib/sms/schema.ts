import type Database from "better-sqlite3";

let ready = false;

/** Campaign tables live in the dialer SQLite file. Dialer tables are not altered. */
export function ensureSmsSchema(db: Database.Database) {
  if (ready) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS sms_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER,
      name TEXT NOT NULL DEFAULT '',
      first_name TEXT,
      last_name TEXT,
      company TEXT NOT NULL DEFAULT '',
      title TEXT,
      phone_e164 TEXT NOT NULL UNIQUE,
      city TEXT,
      country TEXT,
      source TEXT,
      extra_json TEXT NOT NULL DEFAULT '{}',
      contact_state TEXT NOT NULL DEFAULT 'new',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sms_contacts_state ON sms_contacts(contact_state);

    CREATE TABLE IF NOT EXISTS sms_validations (
      phone_e164 TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      is_mobile INTEGER NOT NULL DEFAULT 0,
      owner_match INTEGER,
      eligible INTEGER NOT NULL DEFAULT 0,
      switchboard INTEGER NOT NULL DEFAULT 0,
      owner_name TEXT,
      detail TEXT,
      source TEXT,
      hitta_url TEXT,
      validated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sms_suppressions (
      phone_e164 TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sms_campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      template TEXT NOT NULL,
      segment_json TEXT NOT NULL DEFAULT '{"match":"all","rules":[]}',
      daily_limit INTEGER NOT NULL DEFAULT 40,
      window_start TEXT NOT NULL DEFAULT '09:00',
      window_end TEXT NOT NULL DEFAULT '17:00',
      timezone TEXT NOT NULL DEFAULT 'Europe/Stockholm',
      min_gap_seconds INTEGER NOT NULL DEFAULT 90,
      weekdays_only INTEGER NOT NULL DEFAULT 1,
      exclude_contacted INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sms_recipients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      contact_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      skip_reason TEXT,
      provider_id TEXT,
      error TEXT,
      sent_at TEXT,
      delivered_at TEXT,
      UNIQUE(campaign_id, contact_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sms_recipients_status ON sms_recipients(campaign_id, status);

    CREATE TABLE IF NOT EXISTS sms_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      campaign_id INTEGER,
      recipient_id INTEGER,
      direction TEXT NOT NULL,
      body TEXT NOT NULL,
      provider_id TEXT UNIQUE,
      status TEXT,
      classification TEXT,
      classification_reason TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sms_messages_contact ON sms_messages(contact_id, id);

    CREATE TABLE IF NOT EXISTS sms_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER,
      message_id INTEGER,
      dedupe_key TEXT UNIQUE,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      sent_at TEXT,
      error TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sms_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sms_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sms_send_lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_send_at TEXT,
      holder TEXT
    );
    INSERT INTO sms_send_lock (id, last_send_at, holder) VALUES (1, NULL, NULL)
      ON CONFLICT(id) DO NOTHING;
  `);
  ready = true;
}
