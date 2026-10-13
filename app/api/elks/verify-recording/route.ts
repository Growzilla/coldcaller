import { NextResponse } from "next/server";
import { processVerifyRecording } from "@/lib/verify-otp";
import { isSignedWebhook } from "@/lib/elks";

export const dynamic = "force-dynamic";

async function parseBody(req: Request): Promise<Record<string, string>> {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    const form = await req.formData();
    const out: Record<string, string> = {};
    form.forEach((v, k) => {
      out[k] = String(v);
    });
    return out;
  }
  const j = await req.json().catch(() => ({}));
  return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, String(v ?? "")]));
}

/** 46elks record/recordcall webhook — transcribe Meta voice OTP. */
export async function POST(req: Request) {
  if (!isSignedWebhook(req)) return new NextResponse(null, { status: 403 });
  const p = await parseBody(req);
  const callid = p.callid || p.id || "";
  const wav = p.wav || "";
  if (!callid || !wav) return new NextResponse(null, { status: 204 });

  void processVerifyRecording({
    callid,
    wavUrl: wav,
    from: p.from,
    to: p.to,
  }).catch((err) => console.error("[verify-recording]", err?.message || err));

  return new NextResponse(null, { status: 204 });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const p: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    p[k] = v;
  });
  return POST(
    new Request(req.url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(p),
    })
  );
}