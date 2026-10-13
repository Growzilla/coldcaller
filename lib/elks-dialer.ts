import { callerIdForCountry, config } from "./config";
import { getDb, activeSession, activeCall, type Lead, type SessionRow } from "./db";
import { publish } from "./bus";
import { getCallerIdOverride, getElksWebhookBase, getOperatorPhone } from "./provider";
import { makeCall, getCall, hangupCall, signWebhookUrl, type ElksCall, type ElksLeg } from "./elks";
import { elksWebrtcUser, ensureWebrtcNumber } from "./elks-rtc";

declare global {
  // eslint-disable-next-line no-var
  var __elksPoller: ReturnType<typeof setInterval> | undefined;
  // eslint-disable-next-line no-var
  var __elksLegsLogged: Set<string> | undefined;
}

/** Public test clip for line checks (~7s). The old files.46elks.com/examples/hello.mp3 is 404. */
export const LINE_CHECK_CLIP = "https://46elks.com/static/sound/make-call.mp3";

const FAILED = new Set(["failed", "busy"]);
const FINAL = new Set(["success", "failed", "busy"]);

/**
 * Every 46elks bridge call is TWO legs: the parent call rings the operator (phone or WebRTC),
 * then a `connect` action rings the lead. The parent `state` describes the OPERATOR leg —
 * "success" only means the operator picked up. The lead's leg lives in `legs[]` and in the
 * connect action's `result` (success | busy | failed).
 */
const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "");

function leadLeg(info: ElksCall, leadPhone: string): ElksLeg | undefined {
  const want = digits(leadPhone);
  return info.legs?.find((l) => digits(l.to) === want);
}

function connectResult(info: ElksCall, leadPhone: string): string | undefined {
  const want = digits(leadPhone);
  for (const a of info.actions ?? []) {
    if (a && typeof a === "object" && "connect" in a && digits(a.connect) === want && typeof a.result === "string") {
      return a.result.toLowerCase();
    }
  }
  return undefined;
}

/** Lead picked up (live): their leg is up / has talk time, or connect already reported success. */
function leadAnswered(info: ElksCall, leadPhone: string): boolean {
  const leg = leadLeg(info, leadPhone);
  if (leg) {
    const st = String(leg.state ?? "").toLowerCase();
    if (Number(leg.duration) > 0 || st === "success" || st === "ongoing") return true;
  }
  return connectResult(info, leadPhone) === "success";
}

/**
 * Final status for the LEAD, from a finished call object:
 * completed (lead talked) | busy | unanswered (lead never picked up) | failed (operator leg never connected).
 */
function leadOutcome(info: ElksCall, leadPhone: string): { status: string; talkSeconds: number | null } {
  if (String(info.direction).toLowerCase() === "incoming") {
    // Inbound: the lead IS the parent caller — no bridged lead leg to inspect.
    const s = String(info.state ?? "").toLowerCase();
    const dur = Number(info.duration);
    return s === "success"
      ? { status: "completed", talkSeconds: Number.isFinite(dur) && dur > 0 ? dur : null }
      : { status: FAILED.has(s) ? s : "unanswered", talkSeconds: null };
  }
  const leg = leadLeg(info, leadPhone);
  const result = connectResult(info, leadPhone);
  const legState = String(leg?.state ?? "").toLowerCase();
  const legDur = Number(leg?.duration);
  if (result === "success" || legState === "success" || (Number.isFinite(legDur) && legDur > 0)) {
    const talk = Number.isFinite(legDur) && legDur > 0 ? legDur : Number(info.duration);
    return { status: "completed", talkSeconds: Number.isFinite(talk) && talk > 0 ? talk : null };
  }
  if (result === "busy" || legState === "busy") return { status: "busy", talkSeconds: null };
  const parent = String(info.state ?? "").toLowerCase();
  if (!info.start || FAILED.has(parent)) return { status: "failed", talkSeconds: null }; // operator never picked up
  return { status: "unanswered", talkSeconds: null };
}

/** Map an in-flight 46elks call → cockpit status. Answered = the LEAD's leg, not the operator's. */
function mapStatus(info: ElksCall, leadPhone: string): string {
  const s = String(info.state ?? "").toLowerCase();
  if (s === "ongoing" && String(info.direction).toLowerCase() === "incoming") return "answered";
  if (s === "ongoing") return leadAnswered(info, leadPhone) ? "answered" : "ringing";
  return s;
}

function leadPhoneForCall(dbCallId: number): string | null {
  const row = getDb()
    .prepare("SELECT l.phone_e164 FROM calls c JOIN leads l ON l.id=c.lead_id WHERE c.id=?")
    .get(dbCallId) as { phone_e164: string | null } | undefined;
  return row?.phone_e164 ?? null;
}

/** Log the raw legs once per call — confirms on the first real bridge how 46elks reports a ringing lead leg. */
function logLegsOnce(info: ElksCall): void {
  const seen = (globalThis.__elksLegsLogged ??= new Set());
  if (!info.legs?.length || seen.has(info.id)) return;
  seen.add(info.id);
  console.log(`[elks] call ${info.id} state=${info.state} legs=${JSON.stringify(info.legs)}`);
}

function whenhangupUrl(dbCallId: number): string | undefined {
  const base = getElksWebhookBase();
  if (!base) return undefined;
  return signWebhookUrl(`${base}/api/elks/whenhangup?dbCallId=${dbCallId}`);
}

/**
 * 46elks "operator bridge" session — no persistent leg. The operator stays ready
 * in the cockpit; each dialLead rings their phone and connects to the lead on answer.
 */
export async function startSession(mode: "phone" | "rtc" = "phone"): Promise<SessionRow> {
  const db = getDb();
  const existing = activeSession();
  if (existing) throw new Error(`Session ${existing.id} already active`);
  if (mode === "rtc") await ensureWebrtcNumber();

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
  const call = activeCall();
  if (call?.vonage_uuid) {
    try {
      await hangupCall(call.vonage_uuid);
    } catch {
      /* already down */
    }
  }
  db.prepare("UPDATE sessions SET status='ended', ended_at=datetime('now') WHERE id=?").run(session.id);
  if (call) db.prepare("UPDATE calls SET ended_at=datetime('now') WHERE id=?").run(call.id);
  publishSession();
  publishCall();
  if (call?.vonage_uuid) {
    const uuid = call.vonage_uuid;
    setTimeout(() => {
      reconcileCall(call.id, uuid).catch(() => {});
    }, 3000);
  }
}

/**
 * Bridge dial: ring the operator → on answer, 46elks connect action bridges the lead.
 * Lead sees caller ID +46766861525 (or forced override).
 */
export async function dialLead(leadId: number): Promise<number> {
  const db = getDb();
  const session = activeSession();
  if (!session || session.status !== "live") throw new Error("No live session — start the line first");
  // activeCall() only sees rows that already have a 46elks id; makeCall takes seconds, so a second
  // P press in that window used to place a parallel call. Count in-flight dials (no id yet) too.
  if (openCallRows().length) throw new Error("A call is already in progress — hang up first");

  const lead = db.prepare("SELECT * FROM leads WHERE id=?").get(leadId) as Lead | undefined;
  if (!lead?.phone_e164) throw new Error("Lead not found or has no phone number");

  const callId = (db.prepare("INSERT INTO calls (lead_id, vonage_status) VALUES (?, 'started')").run(leadId)
    .lastInsertRowid) as number;

  const callerId = callerIdForCountry(lead.country, getCallerIdOverride(), "46elks");
  const leadPhone = lead.phone_e164;
  const rtc = session.mode === "rtc";
  const bridgeTo = rtc ? `+${elksWebrtcUser()}` : getOperatorPhone();

  const bridgeNext = rtc
    ? null
    : (() => {
        const base = getElksWebhookBase();
        if (!base) return null;
        const q = new URLSearchParams({ lead: leadPhone, callerid: callerId });
        return signWebhookUrl(`${base}/api/elks/bridge?${q}`);
      })();

  try {
    const resp = await makeCall({
      from: config.elksNumber,
      to: bridgeTo,
      voiceStart: rtc
        ? { connect: leadPhone, callerid: callerId }
        : bridgeNext
          ? { play: "sound/beep", skippable: false, next: bridgeNext }
          : { connect: leadPhone, callerid: callerId },
      whenhangup: whenhangupUrl(callId),
      timeout: 35,
    });
    // Operator hit hang up while makeCall was in flight → the row is already closed; kill the leg now.
    const cancelled = db
      .prepare("UPDATE calls SET vonage_uuid=? WHERE id=? AND ended_at IS NOT NULL")
      .run(resp.id, callId).changes;
    if (cancelled) {
      await hangupCall(resp.id).catch(() => {});
      publishCall();
      return callId;
    }
    db.prepare("UPDATE calls SET vonage_uuid=?, vonage_status='ringing' WHERE id=?").run(resp.id, callId);
  } catch (err) {
    db.prepare("UPDATE calls SET vonage_status='failed', ended_at=datetime('now') WHERE id=?").run(callId);
    publishCall();
    throw err;
  }

  ensurePoller();
  publishCall();
  return callId;
}

/** Line check: play a short clip to the operator phone to confirm voice path. */
export async function runLineCheck(): Promise<{ ok: boolean; detail: string }> {
  const session = activeSession();
  if (!session || session.status !== "live") return { ok: false, detail: "no live session" };

  if (session.mode === "rtc") return runRtcLineCheck();

  const operator = getOperatorPhone();
  if (!operator) return { ok: false, detail: "no operator phone set" };
  // Ring the mobile and play a clip; the call ends by itself when the clip finishes (or after
  // 25s unanswered). We don't hang it up early — a 4s hangup ended it before anyone could answer.
  const resp = await makeCall({
    from: config.elksNumber,
    to: operator,
    voiceStart: { play: LINE_CHECK_CLIP },
    timeout: 25,
  });
  await new Promise((r) => setTimeout(r, 2000));
  const info = await getCall(resp.id);
  if (!info || FAILED.has(info.state)) return { ok: false, detail: `check call state: ${info?.state ?? "missing"}` };
  return { ok: true, detail: "ringing your mobile — answer to hear the test clip" };
}

/**
 * Browser-line check: 46elks calls our own WebRTC client and plays the clip; the cockpit auto-answers
 * and measures (a) remote RMS = we HEAR the 46elks media path, (b) outbound-rtp bytes = mic SENDS.
 * Holds the request open while the clip plays so the browser measures during it. No call row is
 * created and calls to our WebRTC number cost nothing (46elks: answering via WebRTC 0 öre/min).
 */
async function runRtcLineCheck(): Promise<{ ok: boolean; detail: string }> {
  if (activeCall()) return { ok: false, detail: "call in progress" };
  await ensureWebrtcNumber();
  const resp = await makeCall({
    from: config.elksNumber,
    to: `+${elksWebrtcUser()}`,
    voiceStart: { play: LINE_CHECK_CLIP, skippable: false, next: { play: LINE_CHECK_CLIP, skippable: false } },
    timeout: 15,
  });
  let info: ElksCall | null = null;
  let answered = false;
  for (let i = 0; i < 14; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    info = await getCall(resp.id).catch(() => null);
    const st = String(info?.state ?? "").toLowerCase();
    if (st === "ongoing" && info?.start) answered = true;
    if (FINAL.has(st)) break;
  }
  if (info && !FINAL.has(String(info.state).toLowerCase())) await hangupCall(resp.id).catch(() => {});
  answered ||= Boolean(info?.start);
  return answered
    ? { ok: true, detail: "46elks → browser test leg answered" }
    : { ok: false, detail: `browser never answered the 46elks test leg (state ${info?.state ?? "missing"}) — is the WebRTC client registered?` };
}

export async function sendDtmf(_digits: string): Promise<void> {
  throw new Error("46elks: press the keys on your phone's keypad — tones pass straight through the bridge");
}

/**
 * Unended call rows that still count as "in progress": placed legs (have a 46elks id) plus dials
 * whose makeCall hasn't returned yet (no id, started < 90s ago — older ones are crash leftovers).
 */
function openCallRows(): { id: number; vonage_uuid: string | null }[] {
  return getDb()
    .prepare(
      `SELECT id, vonage_uuid FROM calls WHERE ended_at IS NULL
         AND (vonage_uuid IS NOT NULL OR started_at > datetime('now', '-90 seconds'))
       ORDER BY id DESC`
    )
    .all() as { id: number; vonage_uuid: string | null }[];
}

export async function hangupActiveCall(): Promise<void> {
  const db = getDb();
  // Hang up EVERY open leg, not just the newest — a duplicate dial must never be left ringing.
  const calls = openCallRows();
  if (!calls.length) return;
  for (const call of calls) {
    if (call.vonage_uuid) {
      try {
        await hangupCall(call.vonage_uuid);
      } catch {
        /* */
      }
    }
    // Provisional: lead answered → completed, else the operator cancelled while it rang.
    // whenhangup / the reconcile below replace this with the authoritative lead outcome.
    // A row with no id yet is an in-flight dial: closing it makes dialLead kill the leg on return.
    db.prepare(
      "UPDATE calls SET ended_at=datetime('now'), vonage_status=CASE WHEN answered_at IS NULL THEN 'cancelled' ELSE 'completed' END WHERE id=? AND ended_at IS NULL"
    ).run(call.id);
    if (call.vonage_uuid) {
      const uuid = call.vonage_uuid;
      // Covers the no-tunnel case (no whenhangup): give 46elks a moment to settle the call record.
      setTimeout(() => {
        reconcileCall(call.id, uuid).catch(() => {});
      }, 3000);
    }
  }
  publishCall();
}

/** Write the authoritative lead outcome onto a call row from a FINISHED 46elks call object. */
function applyFinalOutcome(dbCallId: number, info: ElksCall): void {
  const leadPhone = leadPhoneForCall(dbCallId);
  if (!leadPhone) return;
  logLegsOnce(info);
  const { status, talkSeconds } = leadOutcome(info, leadPhone);
  const db = getDb();
  if (status === "completed") {
    // Backdate answered_at from talk time when we never saw the answer live.
    const backdate = talkSeconds ? `-${Math.round(talkSeconds)} seconds` : "+0 seconds";
    db.prepare(
      `UPDATE calls SET vonage_status='completed', duration_s=?,
         answered_at=COALESCE(answered_at, datetime('now', ?)),
         ended_at=COALESCE(ended_at, datetime('now'))
       WHERE id=?`
    ).run(talkSeconds, backdate, dbCallId);
  } else {
    // Lead never talked: clear any provisional answer so stats don't count it.
    db.prepare(
      `UPDATE calls SET vonage_status=?, answered_at=NULL, duration_s=NULL,
         ended_at=COALESCE(ended_at, datetime('now'))
       WHERE id=?`
    ).run(status, dbCallId);
  }
  publishCall();
}

/** Fetch the call from 46elks and finalize it if it has ended. Returns true when finalized. */
async function reconcileCall(dbCallId: number, elksId: string): Promise<boolean> {
  const info = await getCall(elksId);
  if (!info || !FINAL.has(String(info.state).toLowerCase())) return false;
  applyFinalOutcome(dbCallId, info);
  return true;
}

/**
 * Called from /api/elks/whenhangup. The payload's `state` describes the operator leg only, so we
 * re-read the call object for the lead's leg; if that read fails we close the row without
 * claiming an answer (any live-detected answered_at is kept).
 */
export async function finalizeCallFromWebhook(
  dbCallId: number,
  payload: { state?: string; duration?: string | number; id?: string }
): Promise<void> {
  const db = getDb();
  const call = db.prepare("SELECT * FROM calls WHERE id=?").get(dbCallId) as
    | { id: number; vonage_uuid: string | null; answered_at: string | null }
    | undefined;
  if (!call) return;

  const elksId = call.vonage_uuid || payload.id;
  if (elksId) {
    try {
      if (await reconcileCall(dbCallId, elksId)) return;
    } catch {
      /* fall through to payload-only close */
    }
  }

  const state = String(payload.state ?? "").toLowerCase();
  const status = call.answered_at ? "completed" : FAILED.has(state) ? "failed" : "unanswered";
  db.prepare("UPDATE calls SET vonage_status=?, ended_at=COALESCE(ended_at, datetime('now')) WHERE id=?").run(
    status,
    dbCallId
  );
  publishCall();
}

/** Start the status poller (idempotent) — inbound webhook uses it to close inbound call rows. */
export function watchCalls(): void {
  ensurePoller();
}

function ensurePoller(): void {
  if (globalThis.__elksPoller) return;
  globalThis.__elksPoller = setInterval(() => {
    pollOnce().catch(() => {});
  }, 1000);
}

function stopPoller(): void {
  if (globalThis.__elksPoller) {
    clearInterval(globalThis.__elksPoller);
    globalThis.__elksPoller = undefined;
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

  if (call?.vonage_uuid && !call.ended_at) {
    try {
      const info = await getCall(call.vonage_uuid);
      if (!info) return;
      if (FINAL.has(String(info.state).toLowerCase())) {
        applyFinalOutcome(call.id, info);
        return;
      }
      const leadPhone = leadPhoneForCall(call.id);
      if (!leadPhone) return;
      logLegsOnce(info);
      const st = mapStatus(info, leadPhone);
      const prev = call.vonage_status;
      if (st === "answered" && !call.answered_at) {
        db.prepare("UPDATE calls SET vonage_status=?, answered_at=datetime('now') WHERE id=?").run(st, call.id);
      } else {
        db.prepare("UPDATE calls SET vonage_status=? WHERE id=?").run(st, call.id);
      }
      if (st !== prev) publishCall();
    } catch {
      /* retry next tick */
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

export const _internal = { FAILED, FINAL, mapStatus, leadAnswered, leadOutcome };