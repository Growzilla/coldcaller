import { NextResponse } from "next/server";
import { deny, fail } from "@/lib/sms/http";
import { dashboard } from "@/lib/sms/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const blocked = deny(req);
  if (blocked) return blocked;
  try {
    return NextResponse.json(dashboard());
  } catch (err) {
    return fail(err);
  }
}
