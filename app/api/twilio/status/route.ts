import { NextResponse } from "next/server";
import { onStatusCallback } from "@/lib/twilio-dialer";
import { isValidTwilioSignature } from "@/lib/twilio";
import { getElksWebhookBase } from "@/lib/provider";

export const dynamic = "force-dynamic";

/**
 * Twilio StatusCallback for bridged calls. Signed by Twilio (X-Twilio-Signature over the PUBLIC
 * tunnel URL) — unsigned/forged requests get 403. The poller is the fallback when this misses.
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const form = await req.formData().catch(() => null);
  const params: Record<string, string> = {};
  form?.forEach((v, k) => {
    params[k] = String(v);
  });
  const publicUrl = `${getElksWebhookBase() ?? url.origin}${url.pathname}${url.search}`;
  if (!isValidTwilioSignature(req.headers.get("x-twilio-signature"), publicUrl, params)) {
    return new NextResponse(null, { status: 403 });
  }
  const dbCallId = Number(url.searchParams.get("dbCallId"));
  if (Number.isFinite(dbCallId) && dbCallId > 0) await onStatusCallback(dbCallId);
  return NextResponse.json({ ok: true });
}
