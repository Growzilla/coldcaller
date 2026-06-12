import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, verifyAuthCookie } from "@/lib/auth";

/**
 * Auth gate for hosted deployments. Active ONLY when DIALER_PASSWORD is set —
 * local dev (no DIALER_PASSWORD) passes every request through unchanged.
 *
 * Public (no auth): Vonage webhooks (/api/vonage/*), /api/health, the login
 * page + endpoint, and Next static assets.
 * Browser access: signed HMAC cookie set by /api/login. The cockpit's SSE
 * EventSource cannot send headers, so the cookie covers it.
 * Programmatic access: Authorization: Bearer <DIALER_API_TOKEN>.
 */

const PUBLIC_PREFIXES = ["/api/vonage/", "/_next/"];
const PUBLIC_EXACT = new Set(["/api/health", "/api/login", "/login", "/favicon.ico"]);

export async function middleware(req: NextRequest) {
  const password = process.env.DIALER_PASSWORD;
  if (!password) return NextResponse.next(); // local dev: auth disabled

  const { pathname } = req.nextUrl;
  if (PUBLIC_EXACT.has(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p)))
    return NextResponse.next();

  const apiToken = process.env.DIALER_API_TOKEN;
  const authz = req.headers.get("authorization");
  if (apiToken && authz === `Bearer ${apiToken}`) return NextResponse.next();

  if (await verifyAuthCookie(password, req.cookies.get(AUTH_COOKIE)?.value))
    return NextResponse.next();

  if (pathname.startsWith("/api/"))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const login = req.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
