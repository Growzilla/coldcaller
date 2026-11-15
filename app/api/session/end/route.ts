import { NextResponse } from "next/server";
import { endSession } from "@/lib/dialer";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const id = Number(body?.id);
    await endSession(Number.isFinite(id) && id > 0 ? id : undefined);
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Failed to end session" }, { status: 400 });
  }
}
