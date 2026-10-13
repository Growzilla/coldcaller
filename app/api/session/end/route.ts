import { NextResponse } from "next/server";
import { endSession } from "@/lib/dialer";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    await endSession();
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Failed to end session" }, { status: 400 });
  }
}
