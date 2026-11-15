import { NextResponse } from "next/server";
import { deny, fail } from "@/lib/sms/http";
import { importContactsCsv } from "@/lib/sms/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const blocked = deny(req);
  if (blocked) return blocked;
  try {
    const ct = req.headers.get("content-type") || "";
    const text = ct.includes("application/json")
      ? String(((await req.json()) as { csv?: string }).csv ?? "")
      : await req.text();
    if (!text.trim()) return NextResponse.json({ error: "CSV is empty." }, { status: 400 });
    return NextResponse.json(importContactsCsv(text, "csv"));
  } catch (err) {
    return fail(err);
  }
}
