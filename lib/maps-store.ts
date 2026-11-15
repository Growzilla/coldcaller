import { getDb } from "./db";
import type { Decision, Gbp, Pack, Region } from "./maps-fit";

/** A stored Google result older than this is fetched again. Rankings move. */
export const MAPS_FRESH_DAYS = 14;

export type StoredPack = Pack & { key: string };

export function ensureMapsSchema() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS maps_queries (
      cache_key TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      trade TEXT NOT NULL,
      city TEXT NOT NULL,
      region TEXT NOT NULL,
      complete INTEGER NOT NULL,
      names_json TEXT NOT NULL,
      checked_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS maps_gbp (
      cache_key TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      matched_name TEXT,
      checked_at TEXT NOT NULL
    );
  `);
}

export function readPack(key: string, refresh: boolean): StoredPack | null {
  if (refresh) return null;
  const row = getDb()
    .prepare(
      `SELECT query, trade, complete, names_json FROM maps_queries
       WHERE cache_key=? AND checked_at >= datetime('now', ?)`
    )
    .get(key, `-${MAPS_FRESH_DAYS} days`) as
    | { query: string; trade: string; complete: number; names_json: string }
    | undefined;
  if (!row) return null;
  return {
    key,
    trade: row.trade,
    query: row.query,
    complete: row.complete === 1,
    names: JSON.parse(row.names_json) as string[],
  };
}

export function writePack(key: string, city: string, region: Region, pack: Pack) {
  getDb()
    .prepare(
      `INSERT INTO maps_queries (cache_key, query, trade, city, region, complete, names_json, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(cache_key) DO UPDATE SET
         query=excluded.query, complete=excluded.complete, names_json=excluded.names_json, checked_at=excluded.checked_at`
    )
    .run(key, pack.query, pack.trade, city, region, pack.complete ? 1 : 0, JSON.stringify(pack.names));
}

export function readGbp(key: string, refresh: boolean): { status: Gbp; matched: string | null } | null {
  if (refresh) return null;
  const row = getDb()
    .prepare(
      `SELECT status, matched_name FROM maps_gbp
       WHERE cache_key=? AND status IN ('none','present') AND checked_at >= datetime('now', ?)`
    )
    .get(key, `-${MAPS_FRESH_DAYS} days`) as { status: Gbp; matched_name: string | null } | undefined;
  if (!row) return null;
  return { status: row.status, matched: row.matched_name };
}

export function writeGbp(key: string, status: Gbp, matched: string | null) {
  if (status === "unknown") return;
  getDb()
    .prepare(
      `INSERT INTO maps_gbp (cache_key, status, matched_name, checked_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(cache_key) DO UPDATE SET
         status=excluded.status, matched_name=excluded.matched_name, checked_at=excluded.checked_at`
    )
    .run(key, status, matched);
}

export function stampLead(id: number, d: Decision) {
  getDb()
    .prepare(
      `UPDATE leads SET maps_fit=?, maps_reason=?, gbp_status=?, maps_rank=?, maps_checked_at=datetime('now') WHERE id=?`
    )
    .run(d.fit, d.reason, d.gbp, d.rank, id);
}

/** When on, the dial queue is callbacks plus leads decideFit marked suitable. */
export function setMapsOnly(on: boolean) {
  getDb()
    .prepare("INSERT INTO meta (key, value) VALUES ('queue_maps_only', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(on ? "1" : "0");
}
