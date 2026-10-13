import { NextResponse } from "next/server";
import { activeSession } from "@/lib/db";
import { getOperatorPhone, setOperatorPhone, clearOperatorPhone } from "@/lib/dialer";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ phone: getOperatorPhone() || null });
}

/**
 * Set the operator mobile that rings first on bridge calls (46elks + Vonage phone mode).
 *   { phone: "+467..." | "07x..." } → set
 *   { phone: null | "" }           → revert to .env OPERATOR_PHONE
 */
export async function POST(req: Request) {
  if (activeSession()) {
    return NextResponse.json({ error: "End the line before changing your phone number" }, { status: 400 });
  }
  const { phone } = await req.json().catch(() => ({ phone: undefined }));
  if (phone === null || phone === "") {
    clearOperatorPhone();
    return NextResponse.json({ phone: getOperatorPhone() || null });
  }
  const e164 = setOperatorPhone(String(phone));
  if (!e164) {
    return NextResponse.json(
      { error: "Couldn't parse that number — try +46…, 07x…, or Swedish 0xx…" },
      { status: 400 }
    );
  }
  return NextResponse.json({ phone: e164 });
}