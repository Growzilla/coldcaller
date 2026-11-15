import { NextResponse } from "next/server";
import { smsAuthOk } from "./auth";

export function deny(req: Request): NextResponse | null {
  if (smsAuthOk(req)) return null;
  return NextResponse.json({ error: "Sign in required" }, { status: 401 });
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  return (await req.json().catch(() => ({}))) as Record<string, unknown>;
}

export function fail(err: unknown) {
  const message = err instanceof Error ? err.message : "Request failed";
  const status = /not found/i.test(message) ? 404 : /cap reached|Pacing|suppressed|permanent/i.test(message) ? 429 : 400;
  return NextResponse.json({ error: message }, { status });
}
