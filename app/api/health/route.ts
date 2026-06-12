import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Public health check — used by the Render health-check probe. No auth, no DB touch. */
export async function GET() {
  return NextResponse.json({ ok: true });
}
