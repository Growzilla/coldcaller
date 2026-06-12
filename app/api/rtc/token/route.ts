import { NextResponse } from "next/server";
import { ensureOperatorUser, mintClientToken } from "@/lib/rtc";
import { assertCallReady } from "@/lib/config";

export const dynamic = "force-dynamic";

/** JWT for the browser's Vonage Client SDK session. */
export async function GET() {
  const notReady = assertCallReady();
  // OPERATOR_PHONE is irrelevant in RTC mode — only credential problems block here.
  if (notReady && !notReady.includes("OPERATOR_PHONE"))
    return NextResponse.json({ error: notReady }, { status: 400 });
  try {
    await ensureOperatorUser();
    return NextResponse.json({ token: mintClientToken() });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Failed to mint token" }, { status: 500 });
  }
}
