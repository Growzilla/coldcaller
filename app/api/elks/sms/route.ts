import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { insertInboundSms } from "@/lib/db";
import { publish } from "@/lib/bus";
import { isSignedWebhook } from "@/lib/elks";

export const dynamic = "force-dynamic";

const ELKS_CALLBACK_IPS = new Set([
  "176.10.154.199",
  "85.24.146.132",
  "185.39.146.243",
]);

async function parseBody(req: Request): Promise<Record<string, string>> {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    const form = await req.formData();
    const out: Record<string, string> = {};
    form.forEach((v, k) => {
      out[k] = String(v);
    });
    return out;
  }
  const j = await req.json().catch(() => ({}));
  return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, String(v ?? "")]));
}

function normalizeE164(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  return s.startsWith("+") ? s : `+${s}`;
}

function clientIp(req: Request): string | null {
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0]?.trim() ?? null;
  return req.headers.get("x-real-ip");
}

/**
 * Inbound SMS to our 46elks number — stores message and returns 204 (no auto-reply).
 * Used to capture Meta WhatsApp Business verification OTPs.
 */
export async function POST(req: Request) {
  if (!isSignedWebhook(req)) return new NextResponse(null, { status: 403 });
  const ip = clientIp(req);
  if (ip && !ELKS_CALLBACK_IPS.has(ip) && process.env.NODE_ENV === "production") {
    console.warn(`[elks/sms] unexpected callback IP: ${ip}`);
  }

  const p = await parseBody(req);
  const id = p.id?.trim();
  const from = normalizeE164(p.from ?? "");
  const to = normalizeE164(p.to ?? "");
  const message = p.message ?? "";
  const direction = (p.direction ?? "incoming").toLowerCase();

  const our = normalizeE164(config.elksNumber);
  if (!id || direction !== "incoming" || to !== our) {
    return new NextResponse(null, { status: 204 });
  }

  const row = insertInboundSms({
    id,
    from_e164: from,
    to_e164: to,
    message,
    created_at: p.created || null,
  });
  if (row) publish({ type: "sms", payload: row });

  return new NextResponse(null, { status: 204 });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const p: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    p[k] = v;
  });
  return POST(
    new Request(req.url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(p),
    })
  );
}