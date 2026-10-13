import { NextResponse } from "next/server";
import { getDialerProvider } from "@/lib/dialer";
import {
  assertElksRtcReady,
  elksRtcCredentials,
  ensureWebrtcNumber,
  fetchWebrtcSecretFromApi,
  setElksWebrtcSecret,
} from "@/lib/elks-rtc";

export const dynamic = "force-dynamic";

/** JsSIP registration creds for the browser line (46elks WebRTC). */
export async function GET() {
  if (getDialerProvider() !== "46elks") {
    return NextResponse.json({ error: "Provider must be 46elks" }, { status: 400 });
  }
  await ensureWebrtcNumber();
  let notReady = assertElksRtcReady();
  if (notReady) {
    const fromApi = await fetchWebrtcSecretFromApi();
    if (fromApi) {
      setElksWebrtcSecret(fromApi);
      notReady = assertElksRtcReady();
    }
  }
  if (notReady) return NextResponse.json({ error: notReady }, { status: 400 });
  return NextResponse.json(elksRtcCredentials());
}