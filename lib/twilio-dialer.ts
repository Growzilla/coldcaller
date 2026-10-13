import { callerIdForCountry, config } from "./config";
import { getDb, activeSession, activeCall, openCalls, type Lead, type SessionRow } from "./db";
import { publish } from "./bus";
import { getElksWebhookBase, getOperatorPhone } from "./provider";
import {
  childCalls,
  dialTwiml,
  FINAL,
  getCall,
  hangupCall,
  makeCall,
  playTwiml,
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
const operatorTarget = (mode: string) =>
  mode === "rtc" ? `client:${config.twilioClientIdentity}` : getOperatorPhone();

/** Public base for status callbacks — the same tunnel URL 46elks uses (set by `npm run tunnel`). */
export function statusCallbackUrl(dbCallId: number): string | undefined {
  const base = getElksWebhookBase();
  return base ? `${base}/api/twilio/status?dbCallId=${dbCallId}` : undefined;
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
  const to = operatorTarget(session.mode);
  if (!to) throw new Error("Set your mobile number first (phone mode) — or use 🎧 browser line");

  const callId = (db.prepare("INSERT INTO calls (lead_id, vonage_status) VALUES (?, 'started')").run(leadId)
    .lastInsertRowid) as number;

  try {
    const resp = await makeCall({
      from: config.twilioNumber,
      to,
      twiml: dialTwiml(lead.phone_e164, callerIdForCountry(lead.country, null, "twilio")),
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

/** rtc: ring the browser client with a clip (cockpit measures it). phone: ring the mobile with it. */
export async function runLineCheck(): Promise<{ ok: boolean; detail: string }> {
  const session = activeSession();
  if (!session || session.status !== "live") return { ok: false, detail: "no live session" };
  if (activeCall()) return { ok: false, detail: "call in progress" };
  const to = operatorTarget(session.mode);
  if (!to) return { ok: false, detail: "no operator phone set" };
  const resp = await makeCall({ from: config.twilioNumber, to, twiml: playTwiml(TWILIO_LINE_CHECK_CLIP), timeout: 15 });
  if (session.mode !== "rtc") return { ok: true, detail: "ringing your mobile — answer to hear the test clip" };
  // Hold the request open while the clip plays so the browser measures during it.
  let info: TwilioCall | null = null;
  let answered = false;
  for (let i = 0; i < 14; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    info = await getCall(resp.sid).catch(() => null);
    if (info?.status === "in-progress") answered = true;
    if (info && FINAL.has(info.status)) break;
  }
  if (info && !FINAL.has(info.status)) await hangupCall(resp.sid).catch(() => {});
  answered ||= info?.status === "completed" && Number(info.duration) > 0;
  return answered
    ? { ok: true, detail: "Twilio → browser test leg answered" }
    : { ok: false, detail: `browser never answered the Twilio test leg (status ${info?.status ?? "missing"}) — is the Device registered?` };
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
