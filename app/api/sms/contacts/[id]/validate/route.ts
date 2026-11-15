import { NextResponse } from "next/server";
import { deny, fail, readJson } from "@/lib/sms/http";
import { validateContact } from "@/lib/sms/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const blocked = deny(req);
  if (blocked) return blocked;
  try {
    const body = await readJson(req);
    const contact = await validateContact(Number(params.id), {
      manual: Boolean(body.manual),
      force: Boolean(body.force),
    });
    return NextResponse.json({ contact });
  } catch (err) {
    return fail(err);
  }
}
