import { NextResponse } from "next/server";
import { getDialerProvider } from "@/lib/dialer";
import { config } from "@/lib/config";
import { assertTwilioReady, voiceAccessToken } from "@/lib/twilio";

export const dynamic = "force-dynamic";

/** Voice access token for the browser Device (incoming-only grant, 1h). */
export async function GET() {
  if (getDialerProvider() !== "twilio") {
    return NextResponse.json({ error: "Provider must be twilio" }, { status: 400 });
  }
  const notReady = assertTwilioReady("rtc");
  if (notReady) return NextResponse.json({ error: notReady }, { status: 400 });
  return NextResponse.json({
    token: voiceAccessToken(config.twilioClientIdentity),
    identity: config.twilioClientIdentity,
    number: config.twilioNumber,
  });
}
