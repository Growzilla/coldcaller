import { NextResponse } from "next/server";
import { deny } from "@/lib/sms/http";
import { listPositive } from "@/lib/sms/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const blocked = deny(req);
  if (blocked) return blocked;
  return NextResponse.json({ replies: listPositive() });
}
