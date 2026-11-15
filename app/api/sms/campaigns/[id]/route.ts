import { NextResponse } from "next/server";
import { deny, fail, readJson } from "@/lib/sms/http";
import { parseSegment } from "@/lib/sms/logic";
import { getCampaign, listRecipients, updateCampaign } from "@/lib/sms/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const blocked = deny(req);
  if (blocked) return blocked;
  const campaign = getCampaign(Number(params.id));
  if (!campaign) return NextResponse.json({ error: "Campaign not found." }, { status: 404 });
  return NextResponse.json({ campaign, recipients: listRecipients(campaign.id), segment: parseSegment(JSON.parse(campaign.segment_json)) });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const blocked = deny(req);
  if (blocked) return blocked;
  try {
    const body = await readJson(req);
    const campaign = updateCampaign(Number(params.id), {
      name: body.name != null ? String(body.name) : undefined,
      template: body.template != null ? String(body.template) : undefined,
      segment: body.segment != null ? parseSegment(body.segment) : undefined,
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
