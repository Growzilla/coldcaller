import { NextResponse } from "next/server";
import { activeSession, getDb, leadByPhone, leadCallStats } from "@/lib/db";
import { markSessionLive, roomName } from "@/lib/vonage";
import { CALLER_IDS } from "@/lib/config";
import { publish } from "@/lib/bus";

export const dynamic = "force-dynamic";

/** Digits-only forms of our own LVNs — an answer webhook with `to` ∈ this set is an inbound PSTN call. */
const OWN_NUMBERS = new Set(Object.values(CALLER_IDS).map((n) => n.replace(/^\+/, "")));

/**
 * Inbound PSTN call (a prospect calling one of our numbers back). Identify the caller
 * against the lead list, log a call row, and push an "inbound" event so the cockpit
 * shows exactly who is calling before Albert picks up.
 */
function answerInbound(fromDigits: string, legUuid: string | null) {
  const e164 = "+" + fromDigits;
  const lead = leadByPhone(e164);
  const stats = lead ? leadCallStats(lead.id) : null;

  // Capture the call even if it's missed — the row (linked to the lead when known)
  // survives for digest/export and follow-up.
  getDb()
    .prepare(
      "INSERT INTO calls (lead_id, vonage_uuid, vonage_status, answered_at) VALUES (?, ?, 'answered', datetime('now'))"
    )
    .run(lead?.id ?? null, legUuid);

  publish({ type: "inbound", payload: { from: e164, lead: lead ?? null, stats } });

  const session = activeSession();
  if (session && (session.status === "live" || session.status === "starting")) {
    // Operator line is up — drop the caller into the room (endOnExit stays false so
    // a prospect hanging up never tears down the operator leg).
    return NextResponse.json([
      { action: "conversation", name: roomName(session.id), startOnEnter: true },
    ]);
  }
  return NextResponse.json([
    {
      action: "talk",
      text: "Hi, you have reached Growzilla. We can't take your call right now, but we will call you back shortly.",
      language: "en-GB",
    },
  ]);
}

/**
 * Vonage answer webhook — fires when the operator's browser leg (Client SDK serverCall)
 * needs call instructions, AND for inbound PSTN calls to our numbers. Inbound calls are
 * identified by `to` being one of our own LVNs; everything else is the browser leg,
 * which is routed into the active session's room and marks the line live.
 */
async function answer(params: URLSearchParams | Record<string, any>) {
  const get = (k: string) =>
    params instanceof URLSearchParams ? params.get(k) : (params as any)[k] ?? null;
  const legUuid = get("uuid");

  const from = String(get("from") ?? "").replace(/^\+/, "");
  const to = String(get("to") ?? "").replace(/^\+/, "");

  // Self leg (from AND to are our own LVNs): the audio line-check / test harness dialing
  // our own number into the room. Join the active session's room — but do NOT mark the
  // session live or touch leg_a_uuid (that's the browser leg's job), and never treat it
  // as an inbound prospect.
  if (OWN_NUMBERS.has(to) && OWN_NUMBERS.has(from)) {
    const session = activeSession();
    if (session) {
      return NextResponse.json([
        { action: "conversation", name: roomName(session.id), startOnEnter: true },
      ]);
    }
    return NextResponse.json([{ action: "talk", text: "No active session for line check." }]);
  }

  if (OWN_NUMBERS.has(to) && /^\d{7,15}$/.test(from)) {
    return answerInbound(from, legUuid ? String(legUuid) : null);
  }

  const session = activeSession();
  if (!session || session.mode !== "rtc") {
    return NextResponse.json([
      { action: "talk", text: "No active dialer session. Start the line in the cockpit first." },
    ]);
  }
  markSessionLive(legUuid ? String(legUuid) : null);
  return NextResponse.json([
    { action: "conversation", name: roomName(session.id), startOnEnter: true, endOnExit: true },
  ]);
}

export async function GET(req: Request) {
  return answer(new URL(req.url).searchParams);
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  return answer(body);
}
