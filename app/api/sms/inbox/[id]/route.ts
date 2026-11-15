import { NextResponse } from "next/server";
import { sendSms } from "@/lib/elks";
import { deny, fail, readJson } from "@/lib/sms/http";
import { sendManualReply, thread } from "@/lib/sms/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const blocked = deny(req);
  if (blocked) return blocked;
  const data = thread(Number(params.id));
  if (!data) return NextResponse.json({ error: "Contact not found." }, { status: 404 });
  return NextResponse.json(data);
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const blocked = deny(req);
  if (blocked) return blocked;
  try {
    const body = await readJson(req);
    const sent = await sendManualReply(Number(params.id), String(body.message ?? ""), (opts) => sendSms(opts));
    return NextResponse.json(sent);
  } catch (err) {
    return fail(err);
  }
}
