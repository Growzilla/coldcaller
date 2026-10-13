import { NextResponse } from "next/server";
import { getDialerProvider, setDialerProvider, assertDialerReady, type DialerProvider } from "@/lib/dialer";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    provider: getDialerProvider(),
    ready: assertDialerReady(),
  });
}

export async function POST(req: Request) {
  const { provider } = await req.json().catch(() => ({}));
  if (provider !== "vonage" && provider !== "46elks") {
    return NextResponse.json({ error: "provider must be 'vonage' or '46elks'" }, { status: 400 });
  }
  setDialerProvider(provider as DialerProvider);
  const notReady = assertDialerReady();
  return NextResponse.json({
    provider: getDialerProvider(),
    ready: notReady,
    warning: notReady ?? undefined,
  });
}