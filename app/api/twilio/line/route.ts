import { NextResponse } from "next/server";
import { configuredTwilioLines, twilioCountry, twilioNumberForLine } from "@/lib/config";
import { getTwilioLine, setTwilioLine } from "@/lib/provider";

export const dynamic = "force-dynamic";

/** Active Australia/Canada line plus the numbers configured on the account. */
export function GET() {
  const line = getTwilioLine();
  return NextResponse.json({
    line,
    country: twilioCountry(line),
    number: twilioNumberForLine(line),
    lines: configuredTwilioLines(),
  });
}

/** { line: "AU" | "CA" } — caller ID and which country's leads this session dials. */
export async function POST(req: Request) {
  const { line } = await req.json().catch(() => ({ line: undefined }));
  if (line !== "AU" && line !== "CA") {
    return NextResponse.json({ error: "line must be AU or CA" }, { status: 400 });
  }
  try {
    setTwilioLine(line);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Could not set line";
    return NextResponse.json({ error: message }, { status: 400 });
  }
  return NextResponse.json({
    line,
    country: twilioCountry(line),
    number: twilioNumberForLine(line),
    lines: configuredTwilioLines(),
  });
}
