import { NextResponse } from "next/server";
import { sendDtmf } from "@/lib/vonage";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { digits } = await req.json().catch(() => ({}));
    if (!digits) return NextResponse.json({ error: "digits required" }, { status: 400 });
    await sendDtmf(String(digits));
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Failed to send tones" }, { status: 400 });
  }
}
