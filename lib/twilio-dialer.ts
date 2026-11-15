import { config, leadFitsTwilioLine, twilioNumberForLine } from "./config";
import { getDb, activeSession, activeCall, openCalls, type Lead, type SessionRow } from "./db";
import { publish } from "./bus";
import { getElksWebhookBase, getOperatorPhone, getTwilioLine } from "./provider";
import {
  childCalls,
  dialTwiml,
  FINAL,
  getCall,
  hangupCall,
  makeCall,
  playTwiml,
  upsertVoiceApp,
  type TwilioCall,
} from "./twilio";

declare global {
  // eslint-disable-next-line no-var
  var __twilioPoller: ReturnType<typeof setInterval> | undefined;
}

/** Twilio's public demo clip — the line check plays it to the browser client. */
export const TWILIO_LINE_CHECK_CLIP = "https://demo.twilio.com/docs/classic.mp3";

/**
 * Same bridge model as 46elks: the PARENT call rings the operator (browser client or mobile),
 * its inline TwiML <Dial>s the lead as a CHILD call. Parent status = operator leg; the lead's
 * answer/busy/no-answer lives on the child.
 */
/** Identity of the browser line that just started. Old tabs keep their previous name. */
export function currentTwilioIdentity(): string {
  const row = getDb().prepare("SELECT value FROM meta WHERE key='twilio_client_identity'").get() as
    | { value?: string }
    | undefined;
  return row?.value || config.twilioClientIdentity;
}

/** New name per Start line, so a leftover tab cannot 486 this line's calls. */
export function rotateTwilioIdentity(): string {
  const id = `rapiddial-${Date.now().toString(36)}`;
  getDb()
    .prepare(
      "INSERT INTO meta (key, value) VALUES ('twilio_client_identity', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    )
    .run(id);
  return id;
}

const operatorTarget = (mode: string) =>
  mode === "rtc" ? `client:${currentTwilioIdentity()}` : getOperatorPhone();

/** Public base for status callbacks — the same tunnel URL 46elks uses (set by `npm run tunnel`). */
export function statusCallbackUrl(dbCallId: number): string | undefined {
  const base = getElksWebhookBase();
  return base ? `${base}/api/twilio/status?dbCallId=${dbCallId}` : undefined;
}

const HANGUP_TWIML = "<Response><Hangup/></Response>";

/** TwiML App the browser Device.connects to. VoiceUrl is refreshed on every token. */
export async function ensureBrowserVoiceApp(): Promise<string> {
  const base = getElksWebhookBase();
  if (!base) throw new Error("No public webhook URL — the tunnel is down, so the browser cannot place calls");
  const voiceUrl = `${base}/api/twilio/client-voice`;
  const row = getDb().prepare("SELECT value FROM meta WHERE key='twilio_app_sid'").get() as { value?: string } | undefined;
  const sid = await upsertVoiceApp(row?.value || null, voiceUrl);
  getDb()
    .prepare("INSERT INTO meta (key, value) VALUES ('twilio_app_sid', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(sid);
  console.log("[twilio] voice app", sid, voiceUrl);
  return sid;
}

/**
 * TwiML for a browser-originated call. The lead number comes from the calls row.
 * A number in the POST body is ignored so the browser cannot dial an arbitrary target.
 */
export function twimlForClientCall(dbCallId: number, callSid: string): string {
  const db = getDb();
  const call = db
    .prepare(
      `SELECT c.id, c.ended_at, c.vonage_uuid, l.phone_e164
       FROM calls c LEFT JOIN leads l ON l.id = c.lead_id
       WHERE c.id = ?`
    )
    .get(dbCallId) as
    | { id: number; ended_at: string | null; vonage_uuid: string | null; phone_e164: string | null }
    | undefined;
  if (!call || call.ended_at || !call.phone_e164) return HANGUP_TWIML;
  if (call.vonage_uuid && call.vonage_uuid !== callSid) return HANGUP_TWIML;
  const from = twilioNumberForLine(getTwilioLine());
  if (!from) return HANGUP_TWIML;
  if (!call.vonage_uuid) {
    db.prepare("UPDATE calls SET vonage_uuid=?, vonage_status='ringing' WHERE id=? AND ended_at IS NULL").run(callSid, dbCallId);
  }
  publishCall();
  ensurePoller();
  return dialTwiml(call.phone_e164, from);
}

export async function startSession(mode: "phone" | "rtc" = "phone"): Promise<SessionRow> {
  const db = getDb();
  const existing = activeSession();
  if (existing) throw new Error(`Session ${existing.id} already active`);
  const sessionId = (db.prepare("INSERT INTO sessions (status, mode) VALUES ('live', ?)").run(mode)
    .lastInsertRowid) as number;
  ensurePoller();
  publishSession();
  return db.prepare("SELECT * FROM sessions WHERE id=?").get(sessionId) as SessionRow;
}

export function markSessionLive(_legUuid: string | null): SessionRow | undefined {
  return activeSession() ?? undefined;
}

export async function endSession(): Promise<void> {
  const db = getDb();
  const session = activeSession();
  if (!session) return;
  await hangupActiveCall();
  db.prepare("UPDATE sessions SET status='ended', ended_at=datetime('now') WHERE id=?").run(session.id);
  publishSession();
}

export async function dialLead(leadId: number): Promise<number> {
  const db = getDb();
  const session = activeSession();
  if (!session || session.status !== "live") throw new Error("No live session — start the line first");
  // Counts in-flight dials too (no Twilio sid yet) — never two calls at once.
  if (openCalls().length) throw new Error("A call is already in progress — hang up first");

  const lead = db.prepare("SELECT * FROM leads WHERE id=?").get(leadId) as Lead | undefined;
  if (!lead?.phone_e164) throw new Error("Lead not found or has no phone number");
  const line = getTwilioLine();
  const from = twilioNumberForLine(line);
  if (!from) throw new Error("No Twilio number for this line — set TWILIO_AUSTRALIA_NUMBER or TWILIO_CANADA_NUMBER");
  const blocked = leadFitsTwilioLine(lead, line);
  if (blocked) throw new Error(blocked);
  if (session.mode !== "rtc") {
    const to = operatorTarget(session.mode);
    if (!to) throw new Error("Set your mobile number first (phone mode) — or use 🎧 browser line");
  }

  const callId = (db.prepare("INSERT INTO calls (lead_id, vonage_status) VALUES (?, 'started')").run(leadId)
    .lastInsertRowid) as number;

  if (session.mode === "rtc") {
    // The browser Device.connects. Inbound client:<identity> hits every tab, and any reject is busy.
    ensurePoller();
    publishCall();
    return callId;
  }

  try {
    const resp = await makeCall({
      from,
      to: operatorTarget(session.mode),
      twiml: dialTwiml(lead.phone_e164, from),
      statusCallback: statusCallbackUrl(callId),
      timeout: 35,
    });
    // Hang up pressed while the create request was in flight → row already closed; kill the leg now.
    const cancelled = db
      .prepare("UPDATE calls SET vonage_uuid=? WHERE id=? AND ended_at IS NOT NULL")
      .run(resp.sid, callId).changes;
    if (cancelled) {
      await hangupCall(resp.sid).catch(() => {});
      publishCall();
      return callId;
    }
    db.prepare("UPDATE calls SET vonage_uuid=?, vonage_status='ringing' WHERE id=?").run(resp.sid, callId);
  } catch (err) {
    db.prepare("UPDATE calls SET vonage_status='failed', ended_at=datetime('now') WHERE id=?").run(callId);
    publishCall();
    throw err;
  }
  ensurePoller();
  publishCall();
  return callId;
}

/** phone: ring the mobile with a clip. rtc skips — an inbound ring to the browser is what marked the line busy. */
export async function runLineCheck(): Promise<{ ok: boolean; detail: string; skipped?: boolean }> {
  const session = activeSession();
  if (!session || session.status !== "live") return { ok: false, detail: "no live session" };
  if (session.mode === "rtc") return { ok: true, skipped: true, detail: "browser places the call" };
  if (activeCall()) return { ok: false, detail: "call in progress" };
  const to = operatorTarget(session.mode);
  if (!to) return { ok: false, detail: "no operator phone set" };
  const from = twilioNumberForLine(getTwilioLine());
  if (!from) return { ok: false, detail: "no Twilio number configured" };
  await makeCall({ from, to, twiml: playTwiml(TWILIO_LINE_CHECK_CLIP), timeout: 15 });
  return { ok: true, detail: "ringing your mobile — answer to hear the test clip" };
}

export async function sendDtmf(_digits: string): Promise<void> {
  throw new Error("Twilio: DTMF to the lead isn't wired yet — use the phone keypad in phone mode");
}

export async function hangupActiveCall(): Promise<void> {
  const db = getDb();
  const calls = openCalls();
  if (!calls.length) return;
  for (const call of calls) {
    if (call.vonage_uuid) await hangupCall(call.vonage_uuid).catch(() => {});
    db.prepare(
      "UPDATE calls SET ended_at=datetime('now'), vonage_status=CASE WHEN answered_at IS NULL THEN 'cancelled' ELSE 'completed' END WHERE id=? AND ended_at IS NULL"
    ).run(call.id);
    if (call.vonage_uuid) {
      const sid = call.vonage_uuid;
      setTimeout(() => {
        reconcileCall(call.id, sid).catch(() => {});
      }, 3000);
    }
  }
  publishCall();
}

/** The lead's leg = the child call to the lead's number (newest first). */
async function leadLeg(parentSid: string): Promise<TwilioCall | undefined> {
  const kids = await childCalls(parentSid);
  return kids[0];
}

/** Final lead outcome: completed | busy | unanswered | failed (operator leg never connected). */
function leadOutcome(parent: TwilioCall, child: TwilioCall | undefined): { status: string; talkSeconds: number | null } {
  const talk = Number(child?.duration);
  if (child && child.status === "completed" && talk > 0) return { status: "completed", talkSeconds: talk };
  if (child?.status === "busy") return { status: "busy", talkSeconds: null };
  if (!child && parent.status !== "completed") return { status: "failed", talkSeconds: null };
  return { status: "unanswered", talkSeconds: null };
}

async function reconcileCall(dbCallId: number, sid: string): Promise<boolean> {
  const info = await getCall(sid);
  if (!info || !FINAL.has(info.status)) return false;
  const { status, talkSeconds } = leadOutcome(info, await leadLeg(sid).catch(() => undefined));
  const db = getDb();
  if (status === "completed") {
    const backdate = talkSeconds ? `-${Math.round(talkSeconds)} seconds` : "+0 seconds";
    db.prepare(
      `UPDATE calls SET vonage_status='completed', duration_s=?,
         answered_at=COALESCE(answered_at, datetime('now', ?)),
         ended_at=COALESCE(ended_at, datetime('now'))
       WHERE id=?`
    ).run(talkSeconds, backdate, dbCallId);
  } else {
    db.prepare(
      `UPDATE calls SET vonage_status=?, answered_at=NULL, duration_s=NULL,
         ended_at=COALESCE(ended_at, datetime('now'))
       WHERE id=?`
    ).run(status, dbCallId);
  }
  publishCall();
  return true;
}

/** From /api/twilio/status — any status event just triggers a re-read; the poller covers misses. */
export async function onStatusCallback(dbCallId: number): Promise<void> {
  const call = getDb().prepare("SELECT vonage_uuid FROM calls WHERE id=?").get(dbCallId) as
    | { vonage_uuid: string | null }
    | undefined;
  if (call?.vonage_uuid) await reconcileCall(dbCallId, call.vonage_uuid).catch(() => false);
}

function ensurePoller(): void {
  if (globalThis.__twilioPoller) return;
  globalThis.__twilioPoller = setInterval(() => {
    pollOnce().catch(() => {});
  }, 1000);
}

async function pollOnce(): Promise<void> {
  const db = getDb();
  const session = activeSession();
  const call = activeCall();
  if (!session && !call) {
    clearInterval(globalThis.__twilioPoller);
    globalThis.__twilioPoller = undefined;
    return;
  }
  if (!call?.vonage_uuid || call.ended_at) return;
  const info = await getCall(call.vonage_uuid);
  if (!info) return;
  if (FINAL.has(info.status)) {
    await reconcileCall(call.id, call.vonage_uuid);
    return;
  }
  // Ringing until the LEAD's child leg is up; the operator leg alone answering doesn't count.
  const child = info.status === "in-progress" ? await leadLeg(info.sid).catch(() => undefined) : undefined;
  const st = child?.status === "in-progress" ? "answered" : "ringing";
  if (st === call.vonage_status) return;
  if (st === "answered" && !call.answered_at) {
    db.prepare("UPDATE calls SET vonage_status=?, answered_at=datetime('now') WHERE id=?").run(st, call.id);
  } else {
    db.prepare("UPDATE calls SET vonage_status=? WHERE id=?").run(st, call.id);
  }
  publishCall();
}

function publishSession(): void {
  publish({ type: "session", payload: activeSession() ?? null });
}

function publishCall(): void {
  const call = getDb().prepare("SELECT * FROM calls ORDER BY id DESC LIMIT 1").get();
  publish({ type: "call", payload: call ?? null });
}
