import { NextResponse } from "next/server";
import { deny, fail, readJson } from "@/lib/sms/http";
import { createContact, listContacts } from "@/lib/sms/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const blocked = deny(req);
  if (blocked) return blocked;
  const url = new URL(req.url);
  const data = listContacts({
    q: url.searchParams.get("q") ?? undefined,
    state: url.searchParams.get("state") ?? undefined,
  });
  return NextResponse.json(data);
}

export async function POST(req: Request) {
  const blocked = deny(req);
  if (blocked) return blocked;
  try {
    const body = await readJson(req);
    const contact = createContact({
      name: body.name != null ? String(body.name) : undefined,
      firstName: body.firstName != null ? String(body.firstName) : undefined,
      lastName: body.lastName != null ? String(body.lastName) : undefined,
      company: body.company != null ? String(body.company) : undefined,
      title: body.title != null ? String(body.title) : undefined,
      phone: String(body.phone ?? ""),
      city: body.city != null ? String(body.city) : undefined,
      source: body.source != null ? String(body.source) : "manual",
    });
    return NextResponse.json({ contact });
  } catch (err) {
    return fail(err);
  }
}
