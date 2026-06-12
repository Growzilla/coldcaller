import { NextResponse } from "next/server";
import { hangupActiveCall } from "@/lib/vonage";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    await hangupActiveCall();
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Failed to hang up" }, { status: 400 });
  }
}
