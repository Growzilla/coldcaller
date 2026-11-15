import { NextResponse } from "next/server";
import { authRequired, sessionCookie, sessionToken, smsPassword } from "@/lib/sms/auth";
import crypto from "crypto";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!authRequired()) return NextResponse.json({ ok: true, authRequired: false });
  const body = (await req.json().catch(() => ({}))) as { password?: string };
  const given = String(body.password ?? "");
  const expected = smsPassword();
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!match) return NextResponse.json({ error: "Wrong password" }, { status: 401 });
  const res = NextResponse.json({ ok: true });
  res.headers.set("set-cookie", sessionCookie(sessionToken()));
  return res;
}
