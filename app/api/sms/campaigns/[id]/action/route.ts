import { NextResponse } from "next/server";
import { deny, fail, readJson } from "@/lib/sms/http";
import type { CampaignStatus } from "@/lib/sms/logic";
import { setCampaignStatus } from "@/lib/sms/store";

export const dynamic = "force-dynamic";

const ACTIONS: Record<string, CampaignStatus> = {
  start: "running",
  resume: "running",
  pause: "paused",
  cancel: "cancelled",
};

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const blocked = deny(req);
  if (blocked) return blocked;
  try {
    const body = await readJson(req);
    const status = ACTIONS[String(body.action ?? "")];
    if (!status) return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    return NextResponse.json({ campaign: setCampaignStatus(Number(params.id), status) });
  } catch (err) {
    return fail(err);
  }
}
