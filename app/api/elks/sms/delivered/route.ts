import { NextResponse } from "next/server";
import { isSignedWebhook } from "@/lib/elks";
import { applyDelivery } from "@/lib/sms/store";

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
  const json = await req.json().catch(() => ({}));
  return Object.fromEntries(Object.entries(json as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")]));
}

/** 46elks `whendelivered` callback. Signed the same way as the other Elks webhooks. */
async function handle(req: Request) {
  if (!isSignedWebhook(req)) return new NextResponse(null, { status: 403 });
  const body = await parseBody(req);
  const id = body.id?.trim();
  const status = (body.status || body.state || "").trim();
  if (id && status) {
    try {
      applyDelivery(id, status);
    } catch (err) {
      console.error("[sms] delivery update failed", err);
    }
  }
  return new NextResponse(null, { status: 204 });
}

export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const p: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    p[k] = v;
  });
  return handle(
    new Request(req.url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(p),
    })
  );
}
