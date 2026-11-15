import { NextResponse } from "next/server";
import { twimlForClientCall } from "@/lib/twilio-dialer";
import { isValidTwilioSignature } from "@/lib/twilio";
import { getElksWebhookBase } from "@/lib/provider";

export const dynamic = "force-dynamic";

const HANGUP = "<Response><Hangup/></Response>";

/**
 * Voice URL for the browser Device.connect. Twilio POSTs dbCallId from the connect params.
 * The lead number is read from that call row, never from the request body.
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
  const dbCallId = Number(params.dbCallId);
  const callSid = params.CallSid || "";
  const xml = Number.isFinite(dbCallId) && dbCallId > 0 && callSid ? twimlForClientCall(dbCallId, callSid) : HANGUP;
  console.log("[twilio] client-voice", {
    dbCallId: Number.isFinite(dbCallId) ? dbCallId : null,
    hasCallSid: Boolean(callSid),
    dial: xml.includes("<Dial"),
    keys: Object.keys(params),
  });
  return new NextResponse(xml, { headers: { "Content-Type": "text/xml" } });
}
