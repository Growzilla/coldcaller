import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { insertInboundSms } from "@/lib/db";
import { publish } from "@/lib/bus";
import { sendSms } from "@/lib/elks";
import { toE164 } from "@/lib/phone";

export const dynamic = "force-dynamic";

/** 46elks caps a single API message at 1600 chars (≈10 concatenated parts). */
const MAX_LEN = 1600;

/**
 * Send a text from +46766861525. Stored in the same table as inbound SMS (from = our number)
 * so the cockpit shows one conversation list.
 *   { to: "+46…" | "07x…", message: "…" }
 */
export async function POST(req: Request) {
  const { to, message } = await req.json().catch(() => ({}));
  const e164 = toE164(String(to ?? ""), "SE");
  if (!e164) return NextResponse.json({ error: "Couldn't parse the recipient number" }, { status: 400 });
  const text = String(message ?? "").trim();
  if (!text) return NextResponse.json({ error: "Message is empty" }, { status: 400 });
  if (text.length > MAX_LEN) return NextResponse.json({ error: `Message too long (max ${MAX_LEN})` }, { status: 400 });
  if (!config.elksApiUsername || !config.elksApiPassword)
    return NextResponse.json({ error: "Missing 46ELKS_API_USERNAME / 46ELKS_API_PASSWORD" }, { status: 400 });

  try {
    const sent = await sendSms({ to: e164, message: text });
    const row = insertInboundSms({
      id: sent.id,
      from_e164: config.elksNumber,
      to_e164: e164,
      message: text,
      created_at: sent.created ?? null,
    });
    if (row) publish({ type: "sms", payload: row });
    return NextResponse.json({
      ok: true,
      id: sent.id,
      to: e164,
      parts: sent.parts ?? null,
      costSek: typeof sent.cost === "number" ? sent.cost / 10000 : null,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Send failed" }, { status: 400 });
  }
}
