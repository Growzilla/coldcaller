import { NextResponse } from "next/server";
import { AUTH_COOKIE, mintAuthCookie } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Exchange the dialer password for a signed HMAC auth cookie (see lib/auth.ts). */
export async function POST(req: Request) {
  const password = process.env.DIALER_PASSWORD;
  if (!password) return NextResponse.json({ ok: true, note: "auth disabled (no DIALER_PASSWORD)" });

  const body = (await req.json().catch(() => ({}))) as { password?: unknown };
  if (typeof body.password !== "string" || body.password !== password)
    return NextResponse.json({ error: "wrong password" }, { status: 401 });

  const { value, maxAge } = await mintAuthCookie(password);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, value, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge,
  });
  return res;
}
