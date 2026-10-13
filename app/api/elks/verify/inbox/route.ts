import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { listInboundVerify } from "@/lib/db";
import { getElksVerifyMode } from "@/lib/provider";
import { getNumber, redactWebhookUrl } from "@/lib/elks";

export const dynamic = "force-dynamic";

export async function GET() {
  let voiceUrl: string | null = null;
  if (config.elksNumberId) {
    const num = await getNumber(config.elksNumberId);
    voiceUrl = redactWebhookUrl(typeof num?.voice_start === "string" ? num.voice_start : null);
  }

  const mode = getElksVerifyMode();
  return NextResponse.json({
    number: config.elksNumber,
    voiceUrl,
    mode,
    listen: mode === "listen",
    missed: mode === "missed",
    forward: mode === "forward",
    verifications: listInboundVerify(20),
  });
}