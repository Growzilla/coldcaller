import { NextResponse } from "next/server";
import { deny } from "@/lib/sms/http";
import { exportContactsCsv } from "@/lib/sms/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const blocked = deny(req);
  if (blocked) return blocked;
  const url = new URL(req.url);
  const csv = exportContactsCsv({
    q: url.searchParams.get("q") ?? undefined,
    state: url.searchParams.get("state") ?? undefined,
  });
  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": "attachment; filename=sms-contacts.csv",
    },
  });
}
