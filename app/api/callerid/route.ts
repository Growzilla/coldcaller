import { NextResponse } from "next/server";
import { CALLER_IDS } from "@/lib/config";
import { getCallerIdOverride, setCallerIdOverride, getDialerProvider } from "@/lib/dialer";

export const dynamic = "force-dynamic";

/** Current caller-ID toggle state + the hardcoded numbers. */
export function GET() {
  return NextResponse.json({
    override: getCallerIdOverride(),
    numbers: CALLER_IDS,
    provider: getDialerProvider(),
    locked: getDialerProvider() !== "vonage",
  });
}

/**
 * Set the caller-ID toggle.
 *   { region: "US" | "SE" } → force that number on every dial
 *   { region: null | "auto" } → auto-pick from each lead's country (default)
 */
export async function POST(req: Request) {
  if (getDialerProvider() !== "vonage") {
    return NextResponse.json({ error: "Caller ID is fixed to the provider's number (46elks/Twilio)" }, { status: 400 });
  }
  const { region } = await req.json().catch(() => ({ region: undefined }));
  if (region === "US" || region === "SE") setCallerIdOverride(region);
  else if (region === null || region === "auto") setCallerIdOverride(null);
  else return NextResponse.json({ error: "region must be US, SE, or auto" }, { status: 400 });
  return NextResponse.json({ override: getCallerIdOverride(), numbers: CALLER_IDS });
}
