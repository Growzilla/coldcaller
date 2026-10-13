import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { insertInboundSms, listInboundSms } from "@/lib/db";
import { getNumber, listSms, redactWebhookUrl } from "@/lib/elks";

export const dynamic = "force-dynamic";

/** Recent inbound SMS — local DB first, optional sync from 46elks API. */
export async function GET(req: Request) {
  const sync = new URL(req.url).searchParams.get("sync") === "1";
  let messages = listInboundSms(30);

  if (sync && config.elksNumber) {
    try {
      const remote = await listSms({ to: config.elksNumber, limit: 30 });
      for (const m of remote) {
        if (m.direction !== "incoming") continue;
        insertInboundSms({
          id: m.id,
          from_e164: m.from.startsWith("+") ? m.from : `+${m.from}`,
          to_e164: m.to.startsWith("+") ? m.to : `+${m.to}`,
          message: m.message,
          created_at: m.created ?? null,
        });
      }
      messages = listInboundSms(30);
    } catch {
      /* local inbox still useful */
    }
  }

  let smsUrl: string | null = null;
  if (config.elksNumberId) {
    const num = await getNumber(config.elksNumberId);
    smsUrl = redactWebhookUrl(typeof num?.sms_url === "string" ? num.sms_url : null);
  }

  return NextResponse.json({
    number: config.elksNumber,
    smsUrl,
    messages,
  });
}