import { NextRequest, NextResponse } from "next/server";

/**
 * Tunnel guard. The cloudflared quick tunnel exposes the WHOLE app publicly, but only the
 * provider webhooks need to be reachable from outside. Without this, anyone holding the
 * trycloudflare URL (it sits in 46elks/Vonage config + logs) could POST /api/call or
 * /api/elks/sms/send and spend our credit.
 *
 * Requests that came through Cloudflare carry Cf-Ray / Cf-Connecting-Ip; the cockpit on
 * localhost never does, so local use is unchanged. 46elks webhooks are additionally
 * token-signed (lib/elks.ts signWebhookUrl).
 *
 * NOTE: deploy/render has its own password middleware — merge the two when that branch
 * picks up the 46elks work (webhook paths below must stay public there too).
 */

const WEBHOOK_PREFIXES = ["/api/vonage/"];
const WEBHOOK_EXACT = new Set([
  "/api/elks/voice",
  "/api/elks/sms",
  "/api/elks/sms/delivered",
  "/api/elks/bridge",
  "/api/elks/whenhangup",
  "/api/elks/verify-recording",
  "/api/twilio/status", // X-Twilio-Signature checked in the route
  "/api/twilio/client-voice", // browser Device.connect — signature checked in the route
]);

/** Team SMS console. The dialer and credit-spending routes stay blocked on the tunnel. */
function isSmsConsole(pathname: string): boolean {
  return pathname === "/sms" || pathname.startsWith("/sms/") || pathname === "/api/sms" || pathname.startsWith("/api/sms/");
}

export function middleware(req: NextRequest) {
  const viaTunnel = req.headers.has("cf-ray") || req.headers.has("cf-connecting-ip");
  if (!viaTunnel) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (WEBHOOK_EXACT.has(pathname) || WEBHOOK_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }
  if (isSmsConsole(pathname)) {
    if (!process.env.SMS_APP_PASSWORD) {
      return new NextResponse("SMS console is locked until SMS_APP_PASSWORD is set.", { status: 503 });
    }
    return NextResponse.next();
  }
  return new NextResponse("Not found", { status: 404 });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
