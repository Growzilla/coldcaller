import { Vonage } from "@vonage/server-sdk";
import { Auth } from "@vonage/auth";
import { tokenGenerate } from "@vonage/jwt";
import { config, privateKey, callerIdForCountry } from "./config";
import { getDb, activeSession, activeCall, type Lead, type SessionRow } from "./db";
import { publish } from "./bus";

declare global {
  // eslint-disable-next-line no-var
  var __vonageClient: Vonage | undefined;
  // eslint-disable-next-line no-var
  var __dialerPoller: ReturnType<typeof setInterval> | undefined;
  // Manual caller-ID override set via the header toggle; null/undefined = auto-by-country.
  // eslint-disable-next-line no-var
  var __callerIdOverride: "US" | "SE" | null | undefined;
}

/** The effective caller-ID region toggle: explicit override, or null for auto-by-country. */
export function getCallerIdOverride(): "US" | "SE" | null {
  return globalThis.__callerIdOverride ?? null;
}
export function setCallerIdOverride(region: "US" | "SE" | null): void {
  globalThis.__callerIdOverride = region;
}

/** Vonage Voice API wants digits-only E.164 (no leading +). */
const digits = (e164: string) => e164.replace(/^\+/, "");

const LIVE_LEG_STATUSES = ["started", "ringing", "answered"];
const FAILED_STATUSES = ["failed", "rejected", "busy", "cancelled", "timeout", "unanswered"];

export function getVonage(): Vonage {
  if (!globalThis.__vonageClient) {
    globalThis.__vonageClient = new Vonage(
      new Auth({
        apiKey: config.vonageApiKey,
        apiSecret: config.vonageApiSecret,
        applicationId: config.applicationId,
        privateKey: privateKey(),
      }),
      // Pin Voice ops (create/get/hangup) to the Client SDK's region so both legs share a conversation.
      { apiHost: config.vonageApiHost }
    );
  }
  return globalThis.__vonageClient;
}

export const roomName = (sessionId: number) => `dialer-room-${sessionId}`;

/**
 * Pre-create the named conversation (in the Client SDK's region) BEFORE either leg joins.
 * Without this, leg A (browser) and leg B (lead) each lazily create "dialer-room-N" via NCCO,
 * producing TWO different conversations for the same name (race) → no shared audio. Creating it
 * once up front means both legs JOIN the same existing room. Proven via scripts/audio-bridge-harness.mjs.
 */
async function ensureConversation(name: string): Promise<void> {
  try {
    const jwt = tokenGenerate(config.applicationId, privateKey(), {});
    const r = await fetch(`${config.vonageApiHost}/v1/conversations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, display_name: name }),
    });
    // 200/201 created, 409 already exists — both fine. Anything else: log and continue.
    if (![200, 201, 409].includes(r.status)) {
      console.warn(`ensureConversation ${name}: HTTP ${r.status}`);
    }
  } catch (e) {
    console.warn(`ensureConversation ${name} failed:`, (e as any)?.message || e);
  }
}

/**
 * Leg A, two flavors:
 *  - mode "phone": ring the operator's mobile; on answer they sit silently in the room.
 *  - mode "rtc":   create the session row only — the browser dials in via the Client SDK
 *    and the answer webhook (app/api/vonage/answer) routes it into the room + marks live.
 */
export async function startSession(mode: "phone" | "rtc" = "phone"): Promise<SessionRow> {
  const db = getDb();
  const existing = activeSession();
  if (existing) throw new Error(`Session ${existing.id} already active`);

  const sessionId = (db.prepare("INSERT INTO sessions (status, mode) VALUES ('starting', ?)").run(mode)
    .lastInsertRowid) as number;

  if (mode === "rtc") {
    await ensureConversation(roomName(sessionId)); // create the room BEFORE the browser leg joins
    ensurePoller(); // watches for stale 'starting' rtc sessions
    publishSession();
    return db.prepare("SELECT * FROM sessions WHERE id=?").get(sessionId) as SessionRow;
  }

  await ensureConversation(roomName(sessionId)); // phone mode: same — room must exist before leg A

  try {
    const resp = await getVonage().voice.createOutboundCall({
      to: [{ type: "phone", number: digits(config.operatorPhone) }],
      from: { type: "phone", number: digits(config.vonageNumber) },
      ringingTimer: 40,
      ncco: [
        { action: "talk", text: "Dialer connected.", language: "en-GB" },
        // endOnExit: operator hanging up tears down any live lead leg too.
        { action: "conversation", name: roomName(sessionId), startOnEnter: true, endOnExit: true },
      ],
    } as any);
    db.prepare("UPDATE sessions SET leg_a_uuid=? WHERE id=?").run(resp.uuid, sessionId);
  } catch (err) {
    db.prepare("UPDATE sessions SET status='failed', ended_at=datetime('now') WHERE id=?").run(sessionId);
    publishSession();
    throw err;
  }

  ensurePoller();
  publishSession();
  return db.prepare("SELECT * FROM sessions WHERE id=?").get(sessionId) as SessionRow;
}

/** Answer webhook calls this when the operator's browser leg lands. */
export function markSessionLive(legUuid: string | null): SessionRow | undefined {
  const db = getDb();
  const session = activeSession();
  if (!session) return undefined;
  db.prepare("UPDATE sessions SET status='live', leg_a_uuid=COALESCE(?, leg_a_uuid) WHERE id=?").run(
    legUuid,
    session.id
  );
  ensurePoller();
  publishSession();
  return db.prepare("SELECT * FROM sessions WHERE id=?").get(session.id) as SessionRow;
}

export async function endSession(): Promise<void> {
  const db = getDb();
  const session = activeSession();
  if (!session) return;
  const call = activeCall();
  for (const uuid of [call?.vonage_uuid, session.leg_a_uuid]) {
    if (!uuid) continue;
    try {
      await getVonage().voice.hangupCall(uuid);
    } catch {
      /* leg already down */
    }
  }
  db.prepare("UPDATE sessions SET status='ended', ended_at=datetime('now') WHERE id=?").run(session.id);
  if (call) db.prepare("UPDATE calls SET ended_at=datetime('now') WHERE id=?").run(call.id);
  publishSession();
  publishCall();
}

/** Leg B: dial the lead straight into the live room. */
export async function dialLead(leadId: number): Promise<number> {
  const db = getDb();
  const session = activeSession();
  if (!session || session.status !== "live")
    throw new Error("No live session — start the line first (and answer your phone)");
  if (activeCall()) throw new Error("A call is already in progress — hang up first");

  const lead = db.prepare("SELECT * FROM leads WHERE id=?").get(leadId) as Lead | undefined;
  if (!lead?.phone_e164) throw new Error("Lead not found or has no phone number");

  const callId = (db.prepare("INSERT INTO calls (lead_id, vonage_status) VALUES (?, 'started')").run(leadId)
    .lastInsertRowid) as number;

  // Caller ID auto-matches the lead's country (US→US#, SE→SE#) unless manually overridden.
  const callerId = callerIdForCountry(lead.country, getCallerIdOverride());

  try {
    const resp = await getVonage().voice.createOutboundCall({
      to: [{ type: "phone", number: digits(lead.phone_e164) }],
      from: { type: "phone", number: digits(callerId) },
      ringingTimer: 35,
      ncco: [{ action: "conversation", name: roomName(session.id), startOnEnter: true }],
    } as any);
    db.prepare("UPDATE calls SET vonage_uuid=? WHERE id=?").run(resp.uuid, callId);
  } catch (err) {
    db.prepare("UPDATE calls SET vonage_status='failed', ended_at=datetime('now') WHERE id=?").run(callId);
    publishCall();
    throw err;
  }

  ensurePoller();
  publishCall();
  return callId;
}

/**
 * Audio line check: dial our own LVN into the live room (auto-answered by our answer
 * webhook's self-leg path) and speak a TTS phrase into it. The browser measures whether
 * it actually HEARS the phrase — proving the full Vonage→room→browser audio path, the
 * same path a prospect's voice takes. Costs ~€0.01 and ~10s. Leg is always hung up.
 */
export async function runLineCheck(): Promise<{ ok: boolean; detail: string }> {
  const session = activeSession();
  if (!session || session.status !== "live") return { ok: false, detail: "no live session" };

  const lvn = digits(config.vonageNumber);
  let legUuid: string | null = null;
  try {
    const resp = await getVonage().voice.createOutboundCall({
      to: [{ type: "phone", number: lvn }],
      from: { type: "phone", number: lvn },
      ringingTimer: 15,
      ncco: [{ action: "conversation", name: roomName(session.id), startOnEnter: true }],
    } as any);
    legUuid = resp.uuid;

    // Wait for the leg to be answered (our own webhook answers ~instantly)
    let answered = false;
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 800));
      const info = await getVonage().voice.getCall(legUuid!).catch(() => null);
      const st = String(info?.status ?? "");
      if (st === "answered") { answered = true; break; }
      if (FAILED_STATUSES.includes(st) || st === "completed") break;
    }
    if (!answered) return { ok: false, detail: "check leg never joined the room" };

    // Raw REST (same call the bridge harness proved) — PUT /talk plays TTS into the leg,
    // audible to everyone in the room.
    const jwt = tokenGenerate(config.applicationId, privateKey(), {});
    await fetch(`${config.vonageApiHost}/v1/calls/${legUuid}/talk`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Audio check. One. Two. Three. Audio check. One. Two. Three.", loop: 1 }),
    });
    await new Promise((r) => setTimeout(r, 7000)); // let it speak while the browser listens
    return { ok: true, detail: "spoke into the room" };
  } finally {
    if (legUuid) {
      try {
        await getVonage().voice.hangupCall(legUuid);
      } catch {
        /* already down */
      }
    }
  }
}

/** Play DTMF digits into the live lead leg — for navigating IVRs ("press 1 for sales"). */
export async function sendDtmf(digits: string): Promise<void> {
  const call = activeCall();
  if (!call?.vonage_uuid) throw new Error("No active call to send tones to");
  if (!/^[0-9*#pP]{1,20}$/.test(digits)) throw new Error("Invalid DTMF digits");
  await getVonage().voice.playDTMF(call.vonage_uuid, digits);
}

export async function hangupActiveCall(): Promise<void> {
  const db = getDb();
  const call = activeCall();
  if (!call) return;
  if (call.vonage_uuid) {
    try {
      await getVonage().voice.hangupCall(call.vonage_uuid);
    } catch {
      /* already ended on the far side */
    }
  }
  db.prepare("UPDATE calls SET ended_at=datetime('now') WHERE id=? AND ended_at IS NULL").run(call.id);
  publishCall();
}

/* ---------- status polling (no webhooks/tunnel needed) ---------- */

function ensurePoller(): void {
  if (globalThis.__dialerPoller) return;
  globalThis.__dialerPoller = setInterval(() => {
    pollOnce().catch(() => {});
  }, 1000);
}

function stopPoller(): void {
  if (globalThis.__dialerPoller) {
    clearInterval(globalThis.__dialerPoller);
    globalThis.__dialerPoller = undefined;
  }
}

async function pollOnce(): Promise<void> {
  const db = getDb();
  const session = activeSession();
  const call = activeCall();
  if (!session && !call) {
    stopPoller();
    return;
  }

  // RTC session where the browser never arrived — fail it instead of blocking forever
  if (session && session.mode === "rtc" && session.status === "starting" && !session.leg_a_uuid) {
    const age = (
      db.prepare("SELECT (julianday('now') - julianday(started_at)) * 86400 AS s FROM sessions WHERE id=?").get(session.id) as any
    ).s;
    if (age > 90) {
      db.prepare("UPDATE sessions SET status='failed', ended_at=datetime('now') WHERE id=?").run(session.id);
      publishSession();
    }
  }

  if (session?.leg_a_uuid) {
    try {
      const info = await getVonage().voice.getCall(session.leg_a_uuid);
      const st = String(info.status);
      if (st === "answered" && session.status !== "live") {
        db.prepare("UPDATE sessions SET status='live' WHERE id=?").run(session.id);
        publishSession();
      } else if (st === "completed" || FAILED_STATUSES.includes(st)) {
        const final = session.status === "live" || st === "completed" ? "ended" : "failed";
        db.prepare("UPDATE sessions SET status=?, ended_at=datetime('now') WHERE id=?").run(final, session.id);
        if (call) db.prepare("UPDATE calls SET ended_at=datetime('now') WHERE id=?").run(call.id);
        publishSession();
        publishCall();
      }
    } catch {
      /* transient API error — next tick retries */
    }
  }

  if (call?.vonage_uuid) {
    try {
      const info = await getVonage().voice.getCall(call.vonage_uuid);
      const st = String(info.status);
      const updates: string[] = ["vonage_status=?"];
      const params: any[] = [st];
      if (st === "answered" && !call.answered_at) {
        updates.push("answered_at=datetime('now')");
      }
      if (st === "completed" || FAILED_STATUSES.includes(st)) {
        updates.push("ended_at=datetime('now')");
        const dur = Number((info as any).duration);
        if (Number.isFinite(dur)) {
          updates.push("duration_s=?");
          params.push(dur);
        }
      }
      params.push(call.id);
      db.prepare(`UPDATE calls SET ${updates.join(", ")} WHERE id=?`).run(...params);
      if (st !== call.vonage_status) publishCall();
    } catch {
      /* transient API error — next tick retries */
    }
  }
}

function publishSession(): void {
  publish({ type: "session", payload: activeSession() ?? null });
}

function publishCall(): void {
  const call = getDb()
    .prepare("SELECT * FROM calls ORDER BY id DESC LIMIT 1")
    .get();
  publish({ type: "call", payload: call ?? null });
}

export const _internal = { LIVE_LEG_STATUSES, FAILED_STATUSES };
