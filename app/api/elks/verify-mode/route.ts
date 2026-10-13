import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { getElksVerifyMode, getOperatorPhone, setElksVerifyMode, type ElksVerifyMode } from "@/lib/provider";
import { getNumber, redactWebhookUrl } from "@/lib/elks";

export const dynamic = "force-dynamic";

function parseMode(body: Record<string, unknown>): ElksVerifyMode {
  if (
    body.mode === "listen" ||
    body.mode === "forward" ||
    body.mode === "missed" ||
    body.mode === "off"
  ) {
    return body.mode;
  }
  if (body.enabled === true) return body.listen === false ? "forward" : "listen";
  return "off";
}

/** Enable Meta/WhatsApp OTP capture on +46766861525 (listen | missed | forward). */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const mode = parseMode(body);
  if (mode === "forward") {
    const operator = getOperatorPhone();
    if (!operator) {
      return NextResponse.json(
        { error: "Set OPERATOR_PHONE (+46…) in .env.local for forward mode", mode: "off" },
        { status: 400 }
      );
    }
  }
  setElksVerifyMode(mode);

  let voiceUrl: string | null = null;
  if (config.elksNumberId) {
    const num = await getNumber(config.elksNumberId);
    voiceUrl = redactWebhookUrl(typeof num?.voice_start === "string" ? num.voice_start : null);
  }

  return NextResponse.json({
    mode: getElksVerifyMode(),
    number: config.elksNumber,
    voiceUrl,
    operator: getOperatorPhone() || null,
    listen: mode === "listen",
    missed: mode === "missed",
    forward: mode === "forward",
    hint:
      mode === "missed"
        ? "Do not answer — Meta flash-call CLI last digits = OTP"
        : mode === "listen"
          ? "Answers + records spoken voice OTP"
          : mode === "forward"
            ? "Bridges inbound to operator mobile"
            : "Verify capture off",
  });
}

export async function GET() {
  const mode = getElksVerifyMode();
  return NextResponse.json({
    mode,
    number: config.elksNumber,
    operator: getOperatorPhone() || null,
    listen: mode === "listen",
    missed: mode === "missed",
    forward: mode === "forward",
  });
}