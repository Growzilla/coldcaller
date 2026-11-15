import { NextRequest, NextResponse } from "next/server";
import { getDialerProvider } from "@/lib/dialer";
import { activeTwilioNumber, assertTwilioReady, voiceAccessToken } from "@/lib/twilio";
import { currentTwilioIdentity, ensureBrowserVoiceApp, rotateTwilioIdentity } from "@/lib/twilio-dialer";

export const dynamic = "force-dynamic";

/** Voice access token for the browser Device (outgoing grant, 1h). */
export async function GET(req: NextRequest) {
  if (getDialerProvider() !== "twilio") {
    return NextResponse.json({ error: "Provider must be twilio" }, { status: 400 });
  }
  const notReady = assertTwilioReady("rtc");
  if (notReady) return NextResponse.json({ error: notReady }, { status: 400 });
  const identity = req.nextUrl.searchParams.get("rotate") === "1" ? rotateTwilioIdentity() : currentTwilioIdentity();
  let applicationSid: string;
  try {
    applicationSid = await ensureBrowserVoiceApp();
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Twilio voice app failed" }, { status: 400 });
  }
  return NextResponse.json({
    token: voiceAccessToken(identity, applicationSid),
    identity,
    number: activeTwilioNumber(),
  });
}
