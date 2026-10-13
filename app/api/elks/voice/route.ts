import { NextResponse } from "next/server";
import { activeCall, activeSession, getDb, insertInboundVerify, leadByPhone, leadCallStats } from "@/lib/db";
import { watchCalls } from "@/lib/elks-dialer";
import { config } from "@/lib/config";
import { extractMissedCallOtp } from "@/lib/missed-otp";
import { getElksVerifyMode, getElksWebhookBase, getOperatorPhone } from "@/lib/provider";
import { publish } from "@/lib/bus";
import { isSignedWebhook, signWebhookUrl } from "@/lib/elks";
import { elksWebrtcUser, ensureWebrtcNumber } from "@/lib/elks-rtc";

export const dynamic = "force-dynamic";

const OWN = new Set([config.elksNumber.replace(/^\+/, ""), config.elksNumber]);

async function parseBody(req: Request): Promise<Record<string, string>> {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    const form = await req.formData();
    const out: Record<string, string> = {};
    form.forEach((v, k) => {
      out[k] = String(v);
    });
    return out;
  }
  const j = await req.json().catch(() => ({}));
  return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, String(v ?? "")]));
}

/**
 * Capture Meta "Missed call" verification without answering.
 * OTP = last digits of inbound CLI. Must hangup/reject immediately.
 */
function handleMissedCall(fromRaw: string, from: string, callid: string | null) {
  const otp = extractMissedCallOtp(fromRaw || from);
  const fromE164 =
    otp?.fromE164 ?? (fromRaw.startsWith("+") ? fromRaw : from ? `+${from}` : null);
  const id = `missed-${callid || Date.now()}`;

  if (otp) {
    insertInboundVerify({
      id,
      callid: callid || id,
      from_e164: fromE164,
      code: otp.code,
      transcript: otp.transcript,
      wav_path: null,
    });
  }

  publish({
    type: "verify",
    payload: {
      status: otp?.code ? "code" : "missed",
      kind: "missed",
      from: fromE164,
      callid,
      code: otp?.code ?? null,
      candidates: otp?.candidates ?? [],
      digits: otp?.digits ?? "",
      transcript: otp?.transcript ?? "Missed call — no usable CLI",
    },
  });

  // Do NOT answer / play / record — flash-call verification needs an unanswered ring.
  return NextResponse.json({ hangup: "reject" });
}

/**
 * Inbound calls to +46766861525.
 * verify listen: answer + record Meta voice OTP.
 * verify missed: reject immediately + store CLI last-digit OTP candidates.
 * otherwise: ring the operator mobile (like a normal phone).
 */
/** 46elks sends E.164; form-urlencoded may turn bare '+' into space — normalize hard. */
function digitsOnly(raw: string): string {
  return String(raw ?? "").replace(/\D/g, "");
}

export async function POST(req: Request) {
  if (!isSignedWebhook(req)) return NextResponse.json({ hangup: "reject" }, { status: 403 });
  const p = await parseBody(req);
  const fromRaw = String(p.from ?? "").trim();
  const from = digitsOnly(fromRaw);
  const to = digitsOnly(p.to ?? "");
  const callid = p.callid || p.id || null;
  const ownDigits = digitsOnly(config.elksNumber);

  // Accept our number with/without +, spaces, or form '+'→space corruption
  if (to !== ownDigits && !OWN.has(to) && !OWN.has(`+${to}`)) {
    return NextResponse.json({ hangup: "reject" });
  }

  const verifyMode = getElksVerifyMode();
  const base = getElksWebhookBase();
  const recordUrl = base ? signWebhookUrl(`${base}/api/elks/verify-recording`) : null;

  // Missed-call first — never answer, never play, never record.
  if (verifyMode === "missed") {
    return handleMissedCall(fromRaw, from, callid);
  }

  if (verifyMode === "listen" && recordUrl) {
    publish({
      type: "verify",
      payload: { status: "ringing", from: fromRaw.startsWith("+") ? fromRaw : from ? `+${from}` : null, callid },
    });
    // Beep first so the caller knows when recording starts, then record full OTP
    // (silence detection OFF — Meta reads codes slowly with pauses).
    return NextResponse.json({
      play: "sound/beep",
      next: {
        record: recordUrl,
        silencedetection: "no",
        timelimit: "90",
      },
    });
  }

  // Browser line live and idle → ring the cockpit (Answer/Decline there). Checked BEFORE the inbound
  // call row is inserted, since that row itself counts as the active call.
  const session = activeSession();
  const toBrowser = session?.status === "live" && session.mode === "rtc" && !activeCall();

  if (/^\d{7,15}$/.test(from)) {
    const e164 = "+" + from;
    const lead = leadByPhone(e164);
    const stats = lead ? leadCallStats(lead.id) : null;
    getDb()
      .prepare(
        "INSERT INTO calls (lead_id, vonage_uuid, vonage_status, answered_at) VALUES (?, ?, 'answered', datetime('now'))"
      )
      .run(lead?.id ?? null, callid);
    publish({ type: "inbound", payload: { from: e164, lead: lead ?? null, stats } });
  }

  // Behave like a normal phone: every inbound call rings the operator's mobile (verify modes
  // listen/missed returned above). No callerid → 46elks shows the ORIGINAL caller's number, so
  // the operator sees who is calling. Poller closes the call row when it ends.
  if (toBrowser) {
    await ensureWebrtcNumber();
    watchCalls();
    // No callerid → the browser's INVITE carries the CALLER's number, which is how the cockpit tells
    // an inbound ring apart from its own outbound bridge legs (those come from our number).
    return NextResponse.json({ connect: `+${elksWebrtcUser()}`, timeout: 30 });
  }

  const operator = getOperatorPhone();
  if (operator) {
    watchCalls();
    return NextResponse.json({ connect: operator });
  }

  return NextResponse.json({
    play: "https://46elks.com/static/sound/make-call.mp3",
    next: { hangup: "reject" },
  });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const p: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    p[k] = v;
  });
  return POST(new Request(req.url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(p) }));
}