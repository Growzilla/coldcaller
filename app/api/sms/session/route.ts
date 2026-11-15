import { NextResponse } from "next/server";
import { authRequired, smsAuthOk } from "@/lib/sms/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return NextResponse.json({ ok: smsAuthOk(req), authRequired: authRequired() });
}
