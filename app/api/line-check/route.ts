import { NextResponse } from "next/server";
import { runLineCheck } from "@/lib/vonage";

export const dynamic = "force-dynamic";

/**
 * Audio-path self test. Dials a TTS leg into the live room; the cockpit measures
 * whether the phrase is actually heard (remote RMS) while this request is in flight.
 */
export async function POST() {
  try {
    const result = await runLineCheck();
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (err: any) {
    return NextResponse.json({ ok: false, detail: err?.message || "Line check failed" }, { status: 400 });
  }
}
