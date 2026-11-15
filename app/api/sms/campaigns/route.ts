import { NextResponse } from "next/server";
import { deny, fail, readJson } from "@/lib/sms/http";
import { parseSegment } from "@/lib/sms/logic";
import { createCampaign, listCampaigns } from "@/lib/sms/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const blocked = deny(req);
  if (blocked) return blocked;
  return NextResponse.json({ campaigns: listCampaigns() });
}

export async function POST(req: Request) {
  const blocked = deny(req);
  if (blocked) return blocked;
  try {
    const body = await readJson(req);
    const campaign = createCampaign({
      name: String(body.name ?? ""),
      template: String(body.template ?? ""),
      segment: parseSegment(body.segment),
      dailyLimit: body.dailyLimit != null ? Number(body.dailyLimit) : undefined,
      windowStart: body.windowStart != null ? String(body.windowStart) : undefined,
      windowEnd: body.windowEnd != null ? String(body.windowEnd) : undefined,
      minGapSeconds: body.minGapSeconds != null ? Number(body.minGapSeconds) : undefined,
      weekdaysOnly: body.weekdaysOnly != null ? Boolean(body.weekdaysOnly) : undefined,
      excludeContacted: body.excludeContacted != null ? Boolean(body.excludeContacted) : undefined,
    });
    return NextResponse.json({ campaign });
  } catch (err) {
    return fail(err);
  }
}
