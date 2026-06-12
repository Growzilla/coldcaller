import { NextResponse } from "next/server";
import { startSession } from "@/lib/vonage";
import { assertCallReady, config } from "@/lib/config";

export const dynamic = "force-dynamic";

const MIN_BALANCE_EUR = 1;

export async function POST(req: Request) {
  const mode = await req
    .json()
    .then((b) => (b?.mode === "rtc" ? "rtc" : "phone") as "rtc" | "phone")
    .catch(() => "phone" as const);
  const notReady = assertCallReady();
  // RTC mode doesn't need OPERATOR_PHONE (no PSTN leg to the operator).
  if (notReady && !(mode === "rtc" && notReady.includes("OPERATOR_PHONE")))
    return NextResponse.json({ error: notReady }, { status: 400 });
  // Hard gate (phone mode only — the RTC line itself is free): a session with <€1 dies
  // mid-call with a cryptic instant "failed" — block early instead.
  if (mode === "phone") try {
    const res = await fetch(
      `https://rest.nexmo.com/account/get-balance?api_key=${config.vonageApiKey}&api_secret=${encodeURIComponent(config.vonageApiSecret)}`,
      { cache: "no-store" }
    );
    if (res.ok) {
      const balance = Number((await res.json()).value);
      if (balance < MIN_BALANCE_EUR)
        return NextResponse.json(
          { error: `Vonage balance €${balance.toFixed(2)} — top up at dashboard.vonage.com → Billing before calling` },
          { status: 400 }
        );
    }
  } catch {
    /* balance check is best-effort — Vonage itself is the final gate */
  }
  try {
    const session = await startSession(mode);
    return NextResponse.json({ session });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Failed to start session" }, { status: 400 });
  }
}
