import { NextResponse } from "next/server";
import { startSession, assertDialerReady, getDialerProvider, getOperatorPhone } from "@/lib/dialer";
import { config } from "@/lib/config";
import { getBalanceSek } from "@/lib/elks";

export const dynamic = "force-dynamic";

const MIN_BALANCE_EUR = 1;

export async function POST(req: Request) {
  const mode = await req
    .json()
    .then((b) => (b?.mode === "rtc" ? "rtc" : "phone") as "rtc" | "phone")
    .catch(() => "phone" as const);
  const provider = getDialerProvider();
  const notReady = assertDialerReady(mode);
  // RTC mode doesn't need OPERATOR_PHONE (no PSTN leg to the operator) on Vonage.
  if (notReady && !(mode === "rtc" && notReady.includes("OPERATOR_PHONE")))
    return NextResponse.json({ error: notReady }, { status: 400 });
  // Hard gate: block when balance too low to complete a call.
  if (provider === "46elks") {
    if (mode === "phone") {
      const op = getOperatorPhone();
      if (!op.startsWith("+46")) {
        return NextResponse.json(
          { error: "46elks phone mode needs your Swedish mobile (+46…) — or use 🎧 browser line" },
          { status: 400 }
        );
      }
    }
    const sek = await getBalanceSek();
    if (sek !== null && sek < 5)
      return NextResponse.json(
        { error: `46elks balance ${sek.toFixed(2)} SEK — top up at 46elks.se before calling` },
        { status: 400 }
      );
  } else if (provider === "twilio") {
    if (mode === "phone" && !getOperatorPhone())
      return NextResponse.json({ error: "Set your mobile number first — or use 🎧 browser line" }, { status: 400 });
  } else if (mode === "phone") try {
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
