import { config } from "./config";
import { getDb } from "./db";
import { reviewDb, reviewedScore, type Prospect } from "./review";

/**
 * Push review verdicts to GHL. Cheap by design (the location has 10,000 req/day shared with the
 * dialer and the importer): tags go through the bulk endpoints (100 contacts per request), and a
 * contact only gets a PUT when its ICP Score / GBP Status actually changes.
 *
 *   review-good|maybe|bad  + rv-<chip> tags
 *   ICP Score  good → 100 + v2 (above every unreviewed lead), bad → 0, maybe → unchanged
 *   GBP Status "present" / "none" when the reviewer checked it
 *   a note when the reviewer wrote one
 *
 * Contacts are matched by phone through one listing of the location (cached in ghl_phone_map).
 */

const BASE = "https://services.leadconnectorhq.com";
const FIELD_ICP_SCORE = "tDMyf4D4VDlN5B2DT0o6";
const FIELD_GBP_STATUS = "eck4ZIajgXz2ZBFagWG6";
const VERDICT_TAGS = ["review-good", "review-maybe", "review-bad"];
const MAP_MAX_AGE_H = 6;

export class QuotaExhausted extends Error {}

type Quota = { remaining: number | null; resetAt: string | null };

function saveQuota(res: Response): void {
  const rem = res.headers.get("x-ratelimit-daily-remaining");
  const reset = Number(res.headers.get("x-ratelimit-daily-reset"));
  if (rem == null) return;
  const q: Quota = { remaining: Number(rem), resetAt: reset ? new Date(Date.now() + reset).toISOString() : null };
  getDb().prepare("INSERT INTO meta(key, value) VALUES('ghl_quota', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(q));
}

export function lastQuota(): Quota | null {
  const row = getDb().prepare("SELECT value FROM meta WHERE key='ghl_quota'").get() as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as Quota) : null;
}

let last = 0;
export async function ghl<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const wait = last + 450 - Date.now(); // 25 req / 10 s burst limit, leave room for the dialer
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    const res = await fetch(BASE + path, {
      method,
      headers: {
        Authorization: `Bearer ${config.ghlToken}`,
        Version: "2021-07-28",
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    saveQuota(res);
    if (res.status === 429 && res.headers.get("x-ratelimit-daily-remaining") === "0") {
      throw new QuotaExhausted("GHL daily API quota (10k/day) is used up — sync again after it resets");
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await new Promise((r) => setTimeout(r, Math.min(2 ** attempt, 30) * 1000));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`GHL ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }
}

/** phone → contact id for every contact in the location (≈1 request per 100 contacts). */
export async function refreshPhoneMap(): Promise<number> {
  const db = reviewDb();
  const upsert = db.prepare(
    "INSERT INTO ghl_phone_map(phone, contact_id, tags, fetched_at) VALUES(?, ?, ?, datetime('now')) ON CONFLICT(phone) DO UPDATE SET contact_id=excluded.contact_id, tags=excluded.tags, fetched_at=excluded.fetched_at"
  );
  let n = 0;
  let searchAfter: unknown[] | undefined;
  for (let page = 0; page < 200; page++) {
    const data = await ghl<{ contacts: { id: string; phone?: string; tags?: string[]; searchAfter?: unknown[] }[] }>("POST", "/contacts/search", {
      locationId: config.ghlLocationId,
      pageLimit: 100,
      ...(searchAfter ? { searchAfter } : {}),
    });
    const contacts = data.contacts ?? [];
    db.transaction(() => {
      for (const c of contacts) if (c.phone) n += upsert.run(c.phone, c.id, JSON.stringify(c.tags ?? [])).changes;
    })();
    if (contacts.length < 100) break;
    searchAfter = contacts[contacts.length - 1].searchAfter;
    if (!searchAfter) break;
  }
  return n;
}

function pending(): Prospect[] {
  return reviewDb()
    .prepare(
      "SELECT * FROM prospects WHERE verdict IS NOT NULL AND (ghl_synced_verdict IS NOT verdict OR ghl_synced_at IS NULL OR ghl_synced_at < reviewed_at) ORDER BY reviewed_at"
    )
    .all() as Prospect[];
}

export function syncPlan() {
  const db = reviewDb();
  const rows = pending();
  const known = db.prepare("SELECT contact_id FROM ghl_phone_map WHERE phone=?");
  const matched = rows.filter((p) => p.ghl_contact_id || known.get(p.phone));
  const mapAge = db.prepare("SELECT MIN(fetched_at) t, COUNT(*) n FROM ghl_phone_map").get() as { t: string | null; n: number };
  return {
    pending: rows.length,
    matchedSoFar: matched.length,
    notInGhl: rows.filter((p) => !p.in_ghl).length,
    phoneMap: { contacts: mapAge.n, oldest: mapAge.t },
    quota: lastQuota(),
  };
}

export type SyncResult = {
  pending: number;
  synced: number;
  notInGhl: number;
  writes: number;
  notes: number;
  stoppedOnQuota: boolean;
  error?: string;
};

/** Mirror verdicts onto the local dialer queue right away (GHL sync makes it stick on the next pull). */
function mirrorToDialer(rows: Prospect[]): void {
  const db = getDb();
  // own status (not 'skipped'): the cockpit's undo re-queues skipped leads
  const skipBad = db.prepare("UPDATE leads SET status='review_bad' WHERE phone_e164=? AND status='queued'");
  const boost = db.prepare("UPDATE leads SET score=? WHERE phone_e164=?");
  db.transaction(() => {
    for (const p of rows) {
      if (p.verdict === "bad") skipBad.run(p.phone);
      const s = reviewedScore(p);
      if (s != null) boost.run(s, p.phone);
    }
  })();
}

export async function syncToGhl(): Promise<SyncResult> {
  if (!config.ghlToken || !config.ghlLocationId) throw new Error("GHL not configured (token file ~/.config/ghl/anvil_systems_pit)");
  const db = reviewDb();
  const rows = pending();
  const res: SyncResult = { pending: rows.length, synced: 0, notInGhl: 0, writes: 0, notes: 0, stoppedOnQuota: false };
  if (!rows.length) return res;
  mirrorToDialer(rows);

  try {
    const known = db.prepare("SELECT contact_id, fetched_at FROM ghl_phone_map WHERE phone=?");
    const stale = rows.some((p) => {
      if (p.ghl_contact_id) return false;
      const k = known.get(p.phone) as { fetched_at: string } | undefined;
      return !k ? true : Date.now() - Date.parse(k.fetched_at.replace(" ", "T") + "Z") > MAP_MAX_AGE_H * 3.6e6;
    });
    if (stale) await refreshPhoneMap();

    const setId = db.prepare("UPDATE prospects SET ghl_contact_id=? WHERE id=?");
    const ready: (Prospect & { ghl_contact_id: string })[] = [];
    for (const p of rows) {
      const id = p.ghl_contact_id ?? (known.get(p.phone) as { contact_id: string } | undefined)?.contact_id;
      if (!id) {
        res.notInGhl++;
        continue;
      }
      if (!p.ghl_contact_id) setId.run(id, p.id);
      ready.push({ ...p, ghl_contact_id: id });
    }

    // Tags: clear old verdict tags, then add the new set — grouped so each request covers 100 contacts.
    const ids = ready.map((p) => p.ghl_contact_id);
    for (let i = 0; i < ids.length; i += 100) {
      await ghl("POST", "/contacts/bulk/tags/update/remove", { locationId: config.ghlLocationId, contacts: ids.slice(i, i + 100), tags: VERDICT_TAGS });
    }
    const groups = new Map<string, string[]>();
    for (const p of ready) {
      const tags = [`review-${p.verdict}`, ...(p.chips ? (JSON.parse(p.chips) as string[]) : []).map((c) => `rv-${c}`)].sort();
      const k = tags.join("|");
      groups.set(k, [...(groups.get(k) ?? []), p.ghl_contact_id]);
    }
    for (const [k, gids] of groups) {
      for (let i = 0; i < gids.length; i += 100) {
        await ghl("POST", "/contacts/bulk/tags/update/add", { locationId: config.ghlLocationId, contacts: gids.slice(i, i + 100), tags: k.split("|") });
      }
    }

    const done = db.prepare("UPDATE prospects SET ghl_synced_verdict=verdict, ghl_synced_at=datetime('now'), ghl_error=NULL WHERE id=?");
    const fail = db.prepare("UPDATE prospects SET ghl_error=? WHERE id=?");
    for (const p of ready) {
      try {
        const chips: string[] = p.chips ? JSON.parse(p.chips) : [];
        const customFields: { id: string; field_value: unknown }[] = [];
        const score = reviewedScore(p);
        if (score != null) customFields.push({ id: FIELD_ICP_SCORE, field_value: score });
        if (chips.includes("has-gbp")) customFields.push({ id: FIELD_GBP_STATUS, field_value: "present" });
        else if (chips.includes("no-gbp")) customFields.push({ id: FIELD_GBP_STATUS, field_value: "none" });
        if (customFields.length) {
          await ghl("PUT", `/contacts/${p.ghl_contact_id}`, { customFields });
          res.writes++;
        }
        if (p.note && p.ghl_synced_at == null) {
          await ghl("POST", `/contacts/${p.ghl_contact_id}/notes`, {
            body: `🔎 Lead review — ${p.verdict}\n${p.note}`,
            ...(config.ghlUserId ? { userId: config.ghlUserId } : {}),
          });
          res.notes++;
        }
        done.run(p.id);
        res.synced++;
      } catch (err) {
        if (err instanceof QuotaExhausted) throw err;
        fail.run(String((err as Error)?.message || err).slice(0, 300), p.id);
      }
    }
  } catch (err) {
    if (err instanceof QuotaExhausted) {
      res.stoppedOnQuota = true;
      res.error = err.message;
    } else {
      res.error = String((err as Error)?.message || err);
    }
  }
  return res;
}
