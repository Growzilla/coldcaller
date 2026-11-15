import { NextResponse } from "next/server";
import { deny, fail, readJson } from "@/lib/sms/http";
import { getSettings, saveSettings } from "@/lib/sms/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const blocked = deny(req);
  if (blocked) return blocked;
  return NextResponse.json(getSettings());
}

export async function PUT(req: Request) {
  const blocked = deny(req);
  if (blocked) return blocked;
  try {
    const body = await readJson(req);
    return NextResponse.json(
      saveSettings({
        notifyNumber: body.notifyNumber != null ? String(body.notifyNumber) : undefined,
        dailyLimit: body.dailyLimit != null ? Number(body.dailyLimit) : undefined,
        windowStart: body.windowStart != null ? String(body.windowStart) : undefined,
        windowEnd: body.windowEnd != null ? String(body.windowEnd) : undefined,
        minGapSeconds: body.minGapSeconds != null ? Number(body.minGapSeconds) : undefined,
        weekdaysOnly: body.weekdaysOnly != null ? Boolean(body.weekdaysOnly) : undefined,
        publicUrl: body.publicUrl != null ? String(body.publicUrl) : undefined,
      })
    );
  } catch (err) {
    return fail(err);
  }
}
