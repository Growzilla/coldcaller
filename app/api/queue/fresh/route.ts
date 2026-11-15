import { NextResponse } from "next/server";
import { setFreshOnly } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Toggle "new leads first": newest never-dialed leads come up first (nothing is hidden). Body: { on: boolean } */
export async function POST(req: Request) {
  const body = await req.json();
  setFreshOnly(Boolean(body.on));
  return NextResponse.json({ ok: true, freshOnly: Boolean(body.on) });
}
