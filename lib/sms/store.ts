import { parse } from "csv-parse/sync";
import { getDb, leadByPhone } from "../db";
import { toE164 } from "../phone";
import { config } from "../config";
import { lookupHitta } from "./hitta";
import {
  clampDailyLimit,
  clampGap,
  CONTACT_STATES,
  fillTemplate,
  gapReady,
  hardDailyCap,
  insideSendWindow,
  matchesSegment,
  parseSegment,
  stockholmDayBounds,
  swedishNumberKind,
  type CampaignStatus,
  type ContactState,
  type Segment,
} from "./logic";

export type SmsContact = {
  id: number;
  lead_id: number | null;
  name: string;
  first_name: string | null;
  last_name: string | null;
  company: string;
  title: string | null;
  phone_e164: string;
  city: string | null;
  country: string | null;
  source: string | null;
  extra_json: string;
  contact_state: ContactState;
  created_at: string;
  updated_at: string;
  kind?: string | null;
  eligible?: number | null;
  owner_match?: number | null;
  switchboard?: number | null;
  validation_detail?: string | null;
  validated_at?: string | null;
  hitta_url?: string | null;
  owner_name?: string | null;
};

export type SmsCampaign = {
  id: number;
  name: string;
  template: string;
  segment_json: string;
  daily_limit: number;
  window_start: string;
  window_end: string;
  timezone: string;
  min_gap_seconds: number;
  weekdays_only: number;
  exclude_contacted: number;
  status: CampaignStatus;
  created_at: string;
  updated_at: string;
};

const nowIso = () => new Date().toISOString();

export function audit(action: string, detail?: string) {
  getDb().prepare("INSERT INTO sms_audit (action, detail, created_at) VALUES (?, ?, ?)").run(action, detail ?? null, nowIso());
  console.log(`[sms] ${action}${detail ? " " + detail : ""}`);
}

export type SmsSettings = {
  notifyNumber: string;
  dailyLimit: number;
  windowStart: string;
  windowEnd: string;
  minGapSeconds: number;
  weekdaysOnly: boolean;
  publicUrl: string;
};

const SETTING_DEFAULTS = (): SmsSettings => ({
  notifyNumber: process.env.SMS_NOTIFY_NUMBER || config.operatorPhone || "",
  dailyLimit: clampDailyLimit(Number(process.env.SMS_DAILY_LIMIT || 50)),
  windowStart: process.env.SMS_WINDOW_START || "09:00",
  windowEnd: process.env.SMS_WINDOW_END || "17:00",
  minGapSeconds: clampGap(Number(process.env.SMS_MIN_GAP_SECONDS || 90)),
  weekdaysOnly: process.env.SMS_WEEKDAYS_ONLY === "0" ? false : true,
  publicUrl: process.env.SMS_PUBLIC_URL || "http://localhost:3100",
});

export function getSettings(): SmsSettings {
  const defaults = SETTING_DEFAULTS();
  const rows = getDb().prepare("SELECT key, value FROM sms_settings").all() as { key: string; value: string }[];
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    notifyNumber: map.notify_number ?? defaults.notifyNumber,
    dailyLimit: clampDailyLimit(Number(map.daily_limit ?? defaults.dailyLimit)),
    windowStart: map.window_start ?? defaults.windowStart,
    windowEnd: map.window_end ?? defaults.windowEnd,
    minGapSeconds: clampGap(Number(map.min_gap_seconds ?? defaults.minGapSeconds)),
    weekdaysOnly: (map.weekdays_only ?? (defaults.weekdaysOnly ? "1" : "0")) !== "0",
    publicUrl: map.public_url ?? defaults.publicUrl,
  };
}

export function saveSettings(input: Partial<SmsSettings>) {
  const current = getSettings();
  const next: SmsSettings = {
    notifyNumber: input.notifyNumber != null ? String(input.notifyNumber).trim() : current.notifyNumber,
    dailyLimit: input.dailyLimit != null ? clampDailyLimit(Number(input.dailyLimit)) : current.dailyLimit,
    windowStart: input.windowStart ?? current.windowStart,
    windowEnd: input.windowEnd ?? current.windowEnd,
    minGapSeconds: input.minGapSeconds != null ? clampGap(Number(input.minGapSeconds)) : current.minGapSeconds,
    weekdaysOnly: input.weekdaysOnly != null ? Boolean(input.weekdaysOnly) : current.weekdaysOnly,
    publicUrl: input.publicUrl != null ? String(input.publicUrl).trim().replace(/\/$/, "") : current.publicUrl,
  };
  const phone = next.notifyNumber ? toE164(next.notifyNumber, "SE") : "";
  if (next.notifyNumber && !phone) throw new Error("Notification number could not be parsed.");
  next.notifyNumber = phone || "";
  const db = getDb();
  const stmt = db.prepare("INSERT INTO sms_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  const pairs: [string, string][] = [
    ["notify_number", next.notifyNumber],
    ["daily_limit", String(next.dailyLimit)],
    ["window_start", next.windowStart],
    ["window_end", next.windowEnd],
    ["min_gap_seconds", String(next.minGapSeconds)],
    ["weekdays_only", next.weekdaysOnly ? "1" : "0"],
    ["public_url", next.publicUrl],
  ];
  const tx = db.transaction(() => {
    for (const [k, v] of pairs) stmt.run(k, v);
  });
  tx();
  audit("settings.save", JSON.stringify({ dailyLimit: next.dailyLimit, window: `${next.windowStart}-${next.windowEnd}`, gap: next.minGapSeconds }));
  return next;
}

function extraOf(row: SmsContact): Record<string, string> {
  try {
    const parsed = JSON.parse(row.extra_json || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function contactVars(row: SmsContact): Record<string, string> {
  const extra = extraOf(row);
  return {
    Namn: row.name,
    name: row.name,
    Förnamn: row.first_name || row.name.split(" ")[0] || "",
    Efternamn: row.last_name || "",
    Företag: row.company,
    company: row.company,
    Stad: row.city || "",
    city: row.city || "",
    Titel: row.title || "",
    title: row.title || "",
    Telefon: row.phone_e164,
    ...extra,
  };
}

const CONTACT_SELECT = `
  SELECT c.*, v.kind, v.eligible, v.owner_match, v.switchboard, v.detail AS validation_detail,
         v.validated_at, v.hitta_url, v.owner_name
  FROM sms_contacts c
  LEFT JOIN sms_validations v ON v.phone_e164 = c.phone_e164
`;

export function listContacts(opts: { q?: string; state?: string; limit?: number; offset?: number } = {}): { rows: SmsContact[]; total: number } {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.state && (CONTACT_STATES as readonly string[]).includes(opts.state)) {
    where.push("c.contact_state = ?");
    args.push(opts.state);
  }
  if (opts.q) {
    where.push("(c.name LIKE ? OR c.company LIKE ? OR c.phone_e164 LIKE ? OR c.city LIKE ? OR c.source LIKE ?)");
    const like = `%${opts.q.replace(/[%_]/g, "")}%`;
    args.push(like, like, like, like, like);
  }
  const sqlWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (getDb().prepare(`SELECT COUNT(*) c FROM sms_contacts c ${sqlWhere}`).get(...args) as { c: number }).c;
  const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
  const offset = Math.max(0, opts.offset ?? 0);
  const rows = getDb()
    .prepare(`${CONTACT_SELECT} ${sqlWhere} ORDER BY c.id DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset) as SmsContact[];
  return { rows, total };
}

export function getContact(id: number): SmsContact | undefined {
  return getDb().prepare(`${CONTACT_SELECT} WHERE c.id = ?`).get(id) as SmsContact | undefined;
}

export function getContactByPhone(phone: string): SmsContact | undefined {
  return getDb().prepare(`${CONTACT_SELECT} WHERE c.phone_e164 = ?`).get(phone) as SmsContact | undefined;
}

function displayName(first: string, last: string, name: string): string {
  const joined = [first, last].filter(Boolean).join(" ").trim();
  return name.trim() || joined;
}

export function createContact(input: {
  name?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  title?: string;
  phone: string;
  city?: string;
  country?: string;
  source?: string;
  extra?: Record<string, string>;
}): SmsContact {
  const phone = toE164(input.phone, "SE");
  if (!phone) throw new Error("Could not parse the phone number.");
  if (isSuppressed(phone)) throw new Error("That number is permanently suppressed.");
  const first = (input.firstName || "").trim();
  const last = (input.lastName || "").trim();
  const name = displayName(first, last, input.name || "");
  const company = (input.company || "").trim();
  const lead = leadByPhone(phone);
  const iso = nowIso();
  getDb()
    .prepare(
      `INSERT INTO sms_contacts
        (lead_id, name, first_name, last_name, company, title, phone_e164, city, country, source, extra_json, contact_state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`
    )
    .run(
      lead?.id ?? null,
      name,
      first || null,
      last || null,
      company,
      (input.title || "").trim() || null,
      phone,
      (input.city || "").trim() || null,
      (input.country || "").trim() || null,
      (input.source || "").trim() || null,
      JSON.stringify(input.extra ?? {}),
      iso,
      iso
    );
  audit("contact.create", phone);
  const row = getContactByPhone(phone);
  if (!row) throw new Error("Contact was not saved.");
  return row;
}

function pick(row: Record<string, string>, keys: string[]): string {
  const entries = Object.entries(row);
  for (const key of keys) {
    const hit = entries.find(([k]) => k.trim().toLowerCase() === key);
    if (hit && String(hit[1]).trim()) return String(hit[1]).trim();
  }
  return "";
}

export function importContactsCsv(text: string, sourceName = "csv"): { imported: number; duplicates: number; invalidPhone: number; suppressed: number } {
  const rows = parse(text, { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true }) as Record<string, string>[];
  let imported = 0;
  let duplicates = 0;
  let invalidPhone = 0;
  let suppressed = 0;
  for (const row of rows) {
    const phoneRaw = pick(row, ["phone", "telefon", "mobile", "mobil", "phone_e164", "direct_dial", "best_dial"]);
    const phone = toE164(phoneRaw, "SE");
    if (!phone) {
      invalidPhone += 1;
      continue;
    }
    if (isSuppressed(phone) || getContactByPhone(phone)) {
      if (isSuppressed(phone)) suppressed += 1;
      else duplicates += 1;
      continue;
    }
    const first = pick(row, ["first_name", "firstname", "förnamn", "fornamn"]);
    const last = pick(row, ["last_name", "lastname", "efternamn"]);
    const name = pick(row, ["name", "namn", "full_name"]) || [first, last].filter(Boolean).join(" ");
    const known = new Set(["phone", "telefon", "mobile", "mobil", "phone_e164", "direct_dial", "best_dial", "first_name", "firstname", "förnamn", "fornamn", "last_name", "lastname", "efternamn", "name", "namn", "full_name", "company", "företag", "foretag", "title", "titel", "city", "stad", "country", "land"]);
    const extra: Record<string, string> = {};
    for (const [k, v] of Object.entries(row)) {
      if (!known.has(k.trim().toLowerCase()) && String(v ?? "").trim()) extra[k.trim()] = String(v).trim();
    }
    try {
      createContact({
        name,
        firstName: first,
        lastName: last,
        company: pick(row, ["company", "företag", "foretag"]),
        title: pick(row, ["title", "titel"]),
        phone,
        city: pick(row, ["city", "stad"]),
        country: pick(row, ["country", "land"]),
        source: sourceName,
        extra,
      });
      imported += 1;
    } catch {
      duplicates += 1;
    }
  }
  audit("contact.import", JSON.stringify({ imported, duplicates, invalidPhone, suppressed }));
  return { imported, duplicates, invalidPhone, suppressed };
}

export function exportContactsCsv(opts: { q?: string; state?: string } = {}): string {
  const { rows } = listContacts({ ...opts, limit: 5000 });
  const header = ["name", "company", "title", "phone", "city", "country", "state", "eligible", "source"];
  const lines = [header.join(",")];
  for (const row of rows) {
    const cells = [row.name, row.company, row.title ?? "", row.phone_e164, row.city ?? "", row.country ?? "", row.contact_state, row.eligible ? "yes" : "no", row.source ?? ""];
    lines.push(cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","));
  }
  return lines.join("\n");
}

export function setContactState(id: number, state: ContactState) {
  const row = getContact(id);
  if (!row) throw new Error("Contact not found.");
  if (row.contact_state === "opted_out" && state !== "opted_out") {
    throw new Error("Opt-out is permanent. This number stays suppressed.");
  }
  if (!(CONTACT_STATES as readonly string[]).includes(state)) throw new Error("Unknown state.");
  const iso = nowIso();
  getDb().prepare("UPDATE sms_contacts SET contact_state=?, updated_at=? WHERE id=?").run(state, iso, id);
  if (state === "opted_out") suppress(row.phone_e164, "opt_out");
  audit("contact.state", `${id} ${state}`);
}

export function isSuppressed(phone: string): boolean {
  return Boolean(getDb().prepare("SELECT 1 FROM sms_suppressions WHERE phone_e164=?").get(phone));
}

export function suppress(phone: string, reason: string) {
  const iso = nowIso();
  getDb()
    .prepare("INSERT INTO sms_suppressions (phone_e164, reason, created_at) VALUES (?, ?, ?) ON CONFLICT(phone_e164) DO NOTHING")
    .run(phone, reason, iso);
  if (reason === "opt_out") {
    getDb().prepare("UPDATE sms_contacts SET contact_state='opted_out', updated_at=? WHERE phone_e164=?").run(iso, phone);
  }
  getDb()
    .prepare(
      `UPDATE sms_recipients SET status='skipped', skip_reason='suppressed'
       WHERE status='pending' AND contact_id IN (SELECT id FROM sms_contacts WHERE phone_e164=?)`
    )
    .run(phone);
}

export async function validateContact(id: number, opts: { manual?: boolean; force?: boolean } = {}): Promise<SmsContact> {
  const row = getContact(id);
  if (!row) throw new Error("Contact not found.");
  const kind = swedishNumberKind(row.phone_e164);
  if (opts.manual) {
    if (kind !== "mobile") throw new Error("Only mobiles can be confirmed. This number is not a Swedish mobile.");
    const existing = getDb().prepare("SELECT switchboard, detail FROM sms_validations WHERE phone_e164=?").get(row.phone_e164) as
      | { switchboard: number; detail: string }
      | undefined;
    if (existing?.switchboard && !opts.force) {
      throw new Error("hitta.se lists this as a company number. Confirm again with force if you still want to send.");
    }
    const detail = existing?.switchboard
      ? `Operator confirmed despite company listing. ${existing.detail || ""}`.trim()
      : "Operator confirmed this is the owner's mobile.";
    saveValidation(row.phone_e164, {
      kind,
      isMobile: true,
      ownerMatch: true,
      eligible: true,
      switchboard: Boolean(existing?.switchboard),
      ownerName: row.name || null,
      detail,
      source: "operator",
      hittaUrl: existing ? undefined : undefined,
    });
    audit("contact.confirm", row.phone_e164);
    return getContact(id)!;
  }

  const looked = await lookupHitta(row.phone_e164, row.name);
  saveValidation(row.phone_e164, {
    kind: looked.kind,
    isMobile: looked.kind === "mobile",
    ownerMatch: looked.ownerMatch,
    eligible: looked.eligible,
    switchboard: looked.switchboard,
    ownerName: looked.ownerName,
    detail: looked.detail,
    source: "hitta",
    hittaUrl: looked.hittaUrl,
  });
  audit("contact.validate", `${row.phone_e164} eligible=${looked.eligible}`);
  return getContact(id)!;
}

function saveValidation(
  phone: string,
  row: {
    kind: string;
    isMobile: boolean;
    ownerMatch: boolean | null;
    eligible: boolean;
    switchboard: boolean;
    ownerName: string | null;
    detail: string;
    source: string;
    hittaUrl?: string;
  }
) {
  getDb()
    .prepare(
      `INSERT INTO sms_validations
        (phone_e164, kind, is_mobile, owner_match, eligible, switchboard, owner_name, detail, source, hitta_url, validated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(phone_e164) DO UPDATE SET
        kind=excluded.kind, is_mobile=excluded.is_mobile, owner_match=excluded.owner_match,
        eligible=excluded.eligible, switchboard=excluded.switchboard, owner_name=excluded.owner_name,
        detail=excluded.detail, source=excluded.source,
        hitta_url=COALESCE(excluded.hitta_url, sms_validations.hitta_url),
        validated_at=excluded.validated_at`
    )
    .run(
      phone,
      row.kind,
      row.isMobile ? 1 : 0,
      row.ownerMatch == null ? null : row.ownerMatch ? 1 : 0,
      row.eligible ? 1 : 0,
      row.switchboard ? 1 : 0,
      row.ownerName,
      row.detail,
      row.source,
      row.hittaUrl ?? null,
      nowIso()
    );
}

export function listCampaigns(): (SmsCampaign & { pending: number; sent: number; delivered: number; failed: number; replied: number })[] {
  return getDb()
    .prepare(
      `SELECT c.*,
        SUM(CASE WHEN r.status='pending' THEN 1 ELSE 0 END) pending,
        SUM(CASE WHEN r.status IN ('sent','delivered','replied') THEN 1 ELSE 0 END) sent,
        SUM(CASE WHEN r.status='delivered' OR r.delivered_at IS NOT NULL THEN 1 ELSE 0 END) delivered,
        SUM(CASE WHEN r.status='failed' THEN 1 ELSE 0 END) failed,
        SUM(CASE WHEN r.status='replied' THEN 1 ELSE 0 END) replied
       FROM sms_campaigns c
       LEFT JOIN sms_recipients r ON r.campaign_id=c.id
       GROUP BY c.id
       ORDER BY c.id DESC`
    )
    .all() as (SmsCampaign & { pending: number; sent: number; delivered: number; failed: number; replied: number })[];
}

export function getCampaign(id: number): SmsCampaign | undefined {
  return getDb().prepare("SELECT * FROM sms_campaigns WHERE id=?").get(id) as SmsCampaign | undefined;
}

export function createCampaign(input: {
  name: string;
  template: string;
  segment?: Segment;
  dailyLimit?: number;
  windowStart?: string;
  windowEnd?: string;
  minGapSeconds?: number;
  weekdaysOnly?: boolean;
  excludeContacted?: boolean;
}): SmsCampaign {
  const name = input.name.trim();
  const template = input.template.trim();
  if (!name) throw new Error("Campaign name is required.");
  if (!template) throw new Error("SMS template is required.");
  if (template.length > 640) throw new Error("Template is too long (max 640 characters).");
  const settings = getSettings();
  const iso = nowIso();
  const info = getDb()
    .prepare(
      `INSERT INTO sms_campaigns
        (name, template, segment_json, daily_limit, window_start, window_end, timezone, min_gap_seconds, weekdays_only, exclude_contacted, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Europe/Stockholm', ?, ?, ?, 'draft', ?, ?)`
    )
    .run(
      name,
      template,
      JSON.stringify(parseSegment(input.segment)),
      clampDailyLimit(input.dailyLimit ?? Math.min(40, settings.dailyLimit)),
      input.windowStart || settings.windowStart,
      input.windowEnd || settings.windowEnd,
      clampGap(input.minGapSeconds ?? settings.minGapSeconds),
      input.weekdaysOnly === false ? 0 : 1,
      input.excludeContacted === false ? 0 : 1,
      iso,
      iso
    );
  audit("campaign.create", `${info.lastInsertRowid} ${name}`);
  return getCampaign(Number(info.lastInsertRowid))!;
}

export function updateCampaign(id: number, patch: Partial<{ name: string; template: string; segment: Segment; dailyLimit: number; windowStart: string; windowEnd: string; minGapSeconds: number; weekdaysOnly: boolean; excludeContacted: boolean }>) {
  const row = getCampaign(id);
  if (!row) throw new Error("Campaign not found.");
  if (row.status === "cancelled" || row.status === "completed") throw new Error("This campaign can no longer be edited.");
  const iso = nowIso();
  getDb()
    .prepare(
      `UPDATE sms_campaigns SET
        name=?, template=?, segment_json=?, daily_limit=?, window_start=?, window_end=?,
        min_gap_seconds=?, weekdays_only=?, exclude_contacted=?, updated_at=?
       WHERE id=?`
    )
    .run(
      (patch.name ?? row.name).trim(),
      (patch.template ?? row.template).trim(),
      JSON.stringify(patch.segment ? parseSegment(patch.segment) : JSON.parse(row.segment_json)),
      clampDailyLimit(patch.dailyLimit ?? row.daily_limit),
      patch.windowStart ?? row.window_start,
      patch.windowEnd ?? row.window_end,
      clampGap(patch.minGapSeconds ?? row.min_gap_seconds),
      patch.weekdaysOnly == null ? row.weekdays_only : patch.weekdaysOnly ? 1 : 0,
      patch.excludeContacted == null ? row.exclude_contacted : patch.excludeContacted ? 1 : 0,
      iso,
      id
    );
  audit("campaign.update", String(id));
  return getCampaign(id)!;
}

export function enrollCampaign(id: number): { added: number; skipped: number } {
  const campaign = getCampaign(id);
  if (!campaign) throw new Error("Campaign not found.");
  const segment = parseSegment(JSON.parse(campaign.segment_json));
  const contacts = getDb().prepare("SELECT * FROM sms_contacts").all() as SmsContact[];
  let added = 0;
  let skipped = 0;
  const insert = getDb().prepare(
    "INSERT OR IGNORE INTO sms_recipients (campaign_id, contact_id, status) VALUES (?, ?, 'pending')"
  );
  for (const contact of contacts) {
    const reason = skipReason(contact, campaign, segment);
    if (reason) {
      skipped += 1;
      continue;
    }
    const res = insert.run(id, contact.id);
    if (res.changes) added += 1;
  }
  audit("campaign.enroll", `${id} added=${added}`);
  return { added, skipped };
}

export function skipReason(contact: SmsContact, campaign: SmsCampaign, segment: Segment): string | null {
  if (isSuppressed(contact.phone_e164) || contact.contact_state === "opted_out") return "suppressed";
  if (contact.contact_state === "do_not_contact") return "do_not_contact";
  if (contact.contact_state === "in_conversation") return "in_conversation";
  if (campaign.exclude_contacted && contact.contact_state === "contacted") return "already_contacted";
  const validation = getDb().prepare("SELECT eligible FROM sms_validations WHERE phone_e164=?").get(contact.phone_e164) as { eligible: number } | undefined;
  if (!validation?.eligible) return "not_validated";
  const extra = extraOf(contact);
  const bag = {
    name: contact.name,
    company: contact.company,
    title: contact.title,
    city: contact.city,
    country: contact.country,
    source: contact.source,
    phone: contact.phone_e164,
    contact_state: contact.contact_state,
    extra,
  };
  if (!matchesSegment(bag, segment)) return "segment";
  const preview = fillTemplate(campaign.template, contactVars(contact));
  if (preview.missing.length) return "missing_fields";
  return null;
}

export function setCampaignStatus(id: number, status: CampaignStatus) {
  const row = getCampaign(id);
  if (!row) throw new Error("Campaign not found.");
  if (status === "running") {
    if (row.status === "cancelled" || row.status === "completed") throw new Error("Start a new campaign instead.");
    enrollCampaign(id);
  }
  if (status === "cancelled") {
    getDb().prepare("UPDATE sms_recipients SET status='skipped', skip_reason='cancelled' WHERE campaign_id=? AND status='pending'").run(id);
  }
  getDb().prepare("UPDATE sms_campaigns SET status=?, updated_at=? WHERE id=?").run(status, nowIso(), id);
  audit("campaign.status", `${id} ${status}`);
  return getCampaign(id)!;
}

export function listRecipients(campaignId: number) {
  return getDb()
    .prepare(
      `SELECT r.*, c.name, c.company, c.phone_e164
       FROM sms_recipients r JOIN sms_contacts c ON c.id=r.contact_id
       WHERE r.campaign_id=? ORDER BY r.id`
    )
    .all(campaignId) as Record<string, unknown>[];
}

export function sentToday(now: Date, campaignId?: number): number {
  const { startIso, endIso } = stockholmDayBounds(now);
  if (campaignId) {
    return (
      getDb()
        .prepare(
          `SELECT COUNT(*) c FROM sms_recipients
           WHERE campaign_id=? AND status IN ('sending','sent','delivered','replied')
             AND sent_at>=? AND sent_at<?`
        )
        .get(campaignId, startIso, endIso) as { c: number }
    ).c;
  }
  return (
    getDb()
      .prepare("SELECT COUNT(*) c FROM sms_messages WHERE direction='out' AND created_at>=? AND created_at<?")
      .get(startIso, endIso) as { c: number }
  ).c;
}

export function lastSendAt(): string | null {
  const row = getDb().prepare("SELECT last_send_at FROM sms_send_lock WHERE id=1").get() as { last_send_at: string | null } | undefined;
  return row?.last_send_at ?? null;
}

export type ClaimedSend = {
  recipientId: number;
  campaignId: number;
  contactId: number;
  phone: string;
  body: string;
  whendelivered?: string;
};

export function claimNextSend(now: Date): ClaimedSend | { wait: string } | null {
  const db = getDb();
  return db.transaction(() => {
    const campaign = db
      .prepare("SELECT * FROM sms_campaigns WHERE status='running' ORDER BY id")
      .all() as SmsCampaign[];
    if (!campaign.length) return null;
    const settings = getSettings();
    const window = insideSendWindow(now, settings.windowStart, settings.windowEnd, settings.weekdaysOnly);
    if (!window.ok) return { wait: window.reason };
    const gap = gapReady(now, lastSendAt(), settings.minGapSeconds);
    if (!gap.ok) return { wait: gap.reason };
    if (sentToday(now) >= settings.dailyLimit) return { wait: `Global daily limit reached (${settings.dailyLimit}).` };

    for (const item of campaign) {
      const ownWindow = insideSendWindow(now, item.window_start, item.window_end, Boolean(item.weekdays_only));
      if (!ownWindow.ok) continue;
      const ownGap = gapReady(now, lastSendAt(), Math.max(settings.minGapSeconds, item.min_gap_seconds));
      if (!ownGap.ok) return { wait: ownGap.reason };
      if (sentToday(now, item.id) >= item.daily_limit) continue;
      const pending = db
        .prepare(
          `SELECT r.id recipient_id, r.campaign_id, c.*
           FROM sms_recipients r JOIN sms_contacts c ON c.id=r.contact_id
           WHERE r.campaign_id=? AND r.status='pending' ORDER BY r.id LIMIT 25`
        )
        .all(item.id) as (SmsContact & { recipient_id: number; campaign_id: number })[];
      const segment = parseSegment(JSON.parse(item.segment_json));
      for (const recipient of pending) {
        const reason = skipReason(recipient, item, segment);
        const filled = reason ? null : fillTemplate(item.template, contactVars(recipient));
        const bad = reason || (filled && filled.missing.length ? "missing_fields" : filled && filled.text.length > 640 ? "too_long" : null);
        if (bad || !filled) {
          db.prepare("UPDATE sms_recipients SET status='skipped', skip_reason=? WHERE id=?").run(bad, recipient.recipient_id);
          continue;
        }
        const claimed = db.prepare("UPDATE sms_recipients SET status='sending' WHERE id=? AND status='pending'").run(recipient.recipient_id);
        if (!claimed.changes) continue;
        db.prepare("UPDATE sms_send_lock SET last_send_at=?, holder=? WHERE id=1").run(now.toISOString(), String(recipient.recipient_id));
        return {
          recipientId: recipient.recipient_id,
          campaignId: item.id,
          contactId: recipient.id,
          phone: recipient.phone_e164,
          body: filled.text,
        };
      }
    }
    return null;
  })();
}

export function markSent(claimed: ClaimedSend, providerId: string) {
  const iso = nowIso();
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("UPDATE sms_recipients SET status='sent', provider_id=?, sent_at=?, error=NULL WHERE id=?").run(providerId, iso, claimed.recipientId);
    db.prepare(
      `INSERT INTO sms_messages (contact_id, campaign_id, recipient_id, direction, body, provider_id, status, created_at)
       VALUES (?, ?, ?, 'out', ?, ?, 'sent', ?)`
    ).run(claimed.contactId, claimed.campaignId, claimed.recipientId, claimed.body, providerId, iso);
    db.prepare("UPDATE sms_contacts SET contact_state='contacted', updated_at=? WHERE id=? AND contact_state='new'").run(iso, claimed.contactId);
  });
  tx();
  audit("sms.sent", `${claimed.phone} ${providerId}`);
}

export function markSendFailed(claimed: ClaimedSend, error: string) {
  getDb().prepare("UPDATE sms_recipients SET status='failed', error=?, sent_at=? WHERE id=?").run(error.slice(0, 300), nowIso(), claimed.recipientId);
  audit("sms.failed", `${claimed.phone} ${error.slice(0, 180)}`);
}

export function maybeCompleteCampaigns() {
  const rows = getDb().prepare("SELECT id FROM sms_campaigns WHERE status='running'").all() as { id: number }[];
  for (const row of rows) {
    const open = getDb()
      .prepare("SELECT COUNT(*) c FROM sms_recipients WHERE campaign_id=? AND status IN ('pending','sending')")
      .get(row.id) as { c: number };
    if (open.c === 0) {
      getDb().prepare("UPDATE sms_campaigns SET status='completed', updated_at=? WHERE id=?").run(nowIso(), row.id);
      audit("campaign.completed", String(row.id));
    }
  }
}

export function applyDelivery(providerId: string, status: string) {
  const normalized = status.toLowerCase();
  const recipient = getDb().prepare("SELECT * FROM sms_recipients WHERE provider_id=?").get(providerId) as { id: number; status: string } | undefined;
  if (!recipient) return false;
  const iso = nowIso();
  if (normalized === "delivered") {
    const next = recipient.status === "replied" ? "replied" : "delivered";
    getDb().prepare("UPDATE sms_recipients SET status=?, delivered_at=? WHERE id=?").run(next, iso, recipient.id);
    getDb().prepare("UPDATE sms_messages SET status='delivered' WHERE provider_id=?").run(providerId);
  } else if (normalized === "failed" && recipient.status !== "replied") {
    getDb().prepare("UPDATE sms_recipients SET status='failed', error='provider failed' WHERE id=?").run(recipient.id);
    getDb().prepare("UPDATE sms_messages SET status='failed' WHERE provider_id=?").run(providerId);
  }
  audit("sms.delivery", `${providerId} ${normalized}`);
  return true;
}

export function recordInbound(input: { providerId: string; phone: string; body: string; classification: string; reason: string }) {
  const existing = getDb().prepare("SELECT id FROM sms_messages WHERE provider_id=?").get(input.providerId) as { id: number } | undefined;
  if (existing) return { messageId: existing.id, contact: getContactByPhone(input.phone), created: false as const };
  let contact = getContactByPhone(input.phone);
  const iso = nowIso();
  if (!contact) {
    const lead = leadByPhone(input.phone);
    getDb()
      .prepare(
        `INSERT INTO sms_contacts (lead_id, name, company, phone_e164, contact_state, source, created_at, updated_at)
         VALUES (?, ?, '', ?, 'in_conversation', 'inbound', ?, ?)`
      )
      .run(lead?.id ?? null, lead ? [lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.company : input.phone, input.phone, iso, iso);
    contact = getContactByPhone(input.phone);
  }
  if (!contact) throw new Error("Could not store the inbound contact.");
  const info = getDb()
    .prepare(
      `INSERT INTO sms_messages (contact_id, direction, body, provider_id, status, classification, classification_reason, created_at)
       VALUES (?, 'in', ?, ?, 'received', ?, ?, ?)`
    )
    .run(contact.id, input.body, input.providerId, input.classification, input.reason, iso);
  if (input.classification === "opt_out") {
    suppress(input.phone, "opt_out");
    getDb().prepare("UPDATE sms_contacts SET contact_state='opted_out', updated_at=? WHERE id=?").run(iso, contact.id);
    getDb()
      .prepare("UPDATE sms_recipients SET status='skipped', skip_reason='opt_out' WHERE contact_id=? AND status IN ('pending','sent','delivered','sending')")
      .run(contact.id);
  } else {
    getDb().prepare("UPDATE sms_contacts SET contact_state='in_conversation', updated_at=? WHERE id=? AND contact_state!='opted_out'").run(iso, contact.id);
    getDb()
      .prepare("UPDATE sms_recipients SET status='replied' WHERE contact_id=? AND status IN ('sent','delivered','sending')")
      .run(contact.id);
  }
  audit("sms.inbound", `${input.phone} ${input.classification}`);
  return { messageId: Number(info.lastInsertRowid), contact: getContact(contact.id)!, created: true as const };
}

export function hasNotification(key: string): boolean {
  return Boolean(getDb().prepare("SELECT 1 FROM sms_notifications WHERE dedupe_key=?").get(key));
}

export function recordNotification(input: { key: string; contactId: number | null; messageId: number | null; kind: string; body: string; error?: string }) {
  const iso = nowIso();
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO sms_notifications (contact_id, message_id, dedupe_key, kind, body, sent_at, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(input.contactId, input.messageId, input.key, input.kind, input.body, input.error ? null : iso, input.error ?? null, iso);
}

export function listInbox() {
  return getDb()
    .prepare(
      `SELECT c.id, c.name, c.company, c.phone_e164, c.contact_state,
              m.body last_body, m.classification, m.direction last_direction, m.created_at last_at
       FROM sms_contacts c
       JOIN sms_messages m ON m.id = (SELECT id FROM sms_messages WHERE contact_id=c.id ORDER BY id DESC LIMIT 1)
       ORDER BY m.id DESC LIMIT 200`
    )
    .all();
}

export function thread(contactId: number) {
  const contact = getContact(contactId);
  if (!contact) return null;
  const messages = getDb().prepare("SELECT * FROM sms_messages WHERE contact_id=? ORDER BY id").all(contactId);
  return { contact, messages };
}

export function listPositive() {
  return getDb()
    .prepare(
      `SELECT m.id, m.body, m.classification_reason, m.created_at, c.id contact_id, c.name, c.company, c.phone_e164,
              n.sent_at notified_at, n.error notify_error
       FROM sms_messages m
       JOIN sms_contacts c ON c.id=m.contact_id
       LEFT JOIN sms_notifications n ON n.message_id=m.id AND n.kind='positive'
       WHERE m.classification='positive'
       ORDER BY m.id DESC LIMIT 200`
    )
    .all();
}

export function dashboard(now = new Date()) {
  const { startIso, endIso, dateKey } = stockholmDayBounds(now);
  const db = getDb();
  const one = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { c: number }).c;
  return {
    date: dateKey,
    hardCap: hardDailyCap(),
    settings: getSettings(),
    provider: {
      configured: Boolean(config.elksApiUsername && config.elksApiPassword),
      from: config.elksNumber,
    },
    today: {
      sent: one("SELECT COUNT(*) c FROM sms_messages WHERE direction='out' AND campaign_id IS NOT NULL AND created_at>=? AND created_at<?", startIso, endIso),
      delivered: one("SELECT COUNT(*) c FROM sms_recipients WHERE delivered_at>=? AND delivered_at<?", startIso, endIso),
      failed: one("SELECT COUNT(*) c FROM sms_recipients WHERE status='failed' AND sent_at>=? AND sent_at<?", startIso, endIso),
      replies: one("SELECT COUNT(*) c FROM sms_messages WHERE direction='in' AND created_at>=? AND created_at<?", startIso, endIso),
      positive: one("SELECT COUNT(*) c FROM sms_messages WHERE classification='positive' AND created_at>=? AND created_at<?", startIso, endIso),
      optOuts: one("SELECT COUNT(*) c FROM sms_suppressions WHERE reason='opt_out' AND created_at>=? AND created_at<?", startIso, endIso),
    },
    totals: {
      contacts: one("SELECT COUNT(*) c FROM sms_contacts"),
      eligible: one("SELECT COUNT(*) c FROM sms_validations WHERE eligible=1"),
      suppressed: one("SELECT COUNT(*) c FROM sms_suppressions"),
      positive: one("SELECT COUNT(*) c FROM sms_messages WHERE classification='positive'"),
      running: one("SELECT COUNT(*) c FROM sms_campaigns WHERE status='running'"),
    },
    audit: db.prepare("SELECT * FROM sms_audit ORDER BY id DESC LIMIT 30").all(),
  };
}

export function listAudit(limit = 50) {
  return getDb().prepare("SELECT * FROM sms_audit ORDER BY id DESC LIMIT ?").all(Math.min(200, limit));
}

export async function sendManualReply(contactId: number, body: string, sender: (opts: { to: string; message: string }) => Promise<{ id: string }>) {
  const contact = getContact(contactId);
  if (!contact) throw new Error("Contact not found.");
  if (isSuppressed(contact.phone_e164) || contact.contact_state === "opted_out") throw new Error("This number is suppressed.");
  const text = body.trim();
  if (!text) throw new Error("Message is empty.");
  if (text.length > 640) throw new Error("Message is too long.");
  const settings = getSettings();
  const now = new Date();
  if (sentToday(now) >= settings.dailyLimit) throw new Error(`Daily send cap reached (${settings.dailyLimit}).`);
  const gate = gapReady(now, lastSendAt(), settings.minGapSeconds);
  if (!gate.ok) throw new Error(gate.reason);
  getDb().prepare("UPDATE sms_send_lock SET last_send_at=?, holder=? WHERE id=1").run(now.toISOString(), `reply:${contactId}`);
  const sent = await sender({ to: contact.phone_e164, message: text });
  const iso = nowIso();
  getDb()
    .prepare(
      `INSERT INTO sms_messages (contact_id, direction, body, provider_id, status, created_at)
       VALUES (?, 'out', ?, ?, 'sent', ?)`
    )
    .run(contactId, text, sent.id, iso);
  audit("sms.reply", `${contact.phone_e164} ${sent.id}`);
  return { id: sent.id };
}
