import { NextResponse } from "next/server";
import { finalizeCallFromWebhook } from "@/lib/elks-dialer";
import { isSignedWebhook } from "@/lib/elks";

export const dynamic = "force-dynamic";

/**
 * 46elks whenhangup webhook — fired when a bridged call ends.
 * Polling is the fallback; this gives instant wrap-up when the tunnel is up.
 */
export async function POST(req: Request) {
  if (!isSignedWebhook(req)) return new NextResponse(null, { status: 403 });
  const url = new URL(req.url);
  const dbCallId = Number(url.searchParams.get("dbCallId"));
  const form = await req.formData().catch(() => null);
  const payload = form
    ? {
        state: String(form.get("state") ?? ""),
        duration: String(form.get("duration") ?? ""),
        id: String(form.get("id") ?? ""),
      }
    : await req.json().catch(() => ({}));

  if (Number.isFinite(dbCallId) && dbCallId > 0) {
    await finalizeCallFromWebhook(dbCallId, payload);
  }
  return NextResponse.json({ ok: true });
}

export async function GET(req: Request) {
  return POST(req);
}