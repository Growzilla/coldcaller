import { NextResponse } from "next/server";
import { sessionCookie } from "@/lib/sms/auth";

export const dynamic = "force-dynamic";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.headers.set("set-cookie", sessionCookie("", 0));
  return res;
}
