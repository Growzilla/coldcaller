import { NextResponse } from "next/server";
import { setElksWebhookBase } from "@/lib/provider";

export const dynamic = "force-dynamic";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

/**
 * Only the local tunnel script may set the base. Anything that came through cloudflared (or any
 * proxy) carries Cf-* / non-loopback X-Forwarded-For headers — otherwise a stranger with the
 * public URL could repoint our whenhangup/record webhooks at their own server.
 */
function isLocalRequest(req: Request): boolean {
  if (req.headers.get("cf-connecting-ip") || req.headers.get("cf-ray")) return false;
  const xff = req.headers.get("x-forwarded-for");
  if (xff && !xff.split(",").every((ip) => LOOPBACK.has(ip.trim()))) return false;
  const realIp = req.headers.get("x-real-ip");
  if (realIp && !LOOPBACK.has(realIp.trim())) return false;
  return true;
}

/** Tunnel script POSTs the public URL here so the Next.js process knows whenhangup targets. */
export async function POST(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ error: "local only" }, { status: 403 });
  const { base } = await req.json().catch(() => ({}));
  if (!base || typeof base !== "string" || !base.startsWith("https://")) {
    return NextResponse.json({ error: "base must be an https URL" }, { status: 400 });
  }
  setElksWebhookBase(base);
  return NextResponse.json({ ok: true, base: base.replace(/\/$/, "") });
}