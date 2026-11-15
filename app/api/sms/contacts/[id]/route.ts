import { NextResponse } from "next/server";
import { deny, fail, readJson } from "@/lib/sms/http";
import type { ContactState } from "@/lib/sms/logic";
import { setContactState } from "@/lib/sms/store";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const blocked = deny(req);
  if (blocked) return blocked;
  try {
    const body = await readJson(req);
    setContactState(Number(params.id), String(body.contactState ?? "") as ContactState);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}
