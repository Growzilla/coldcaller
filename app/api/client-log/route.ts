import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Local cockpit diagnostics. Logged on the dev server; not a public webhook. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  console.log("[client-log]", JSON.stringify(body));
  return NextResponse.json({ ok: true });
}
