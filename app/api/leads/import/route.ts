import { NextResponse } from "next/server";
import { importCsvText } from "@/lib/import";

export const dynamic = "force-dynamic";

/** CSV upload (multipart form, field "file"). Schema auto-detected. */
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "file required" }, { status: 400 });
    const priority = Number(form.get("priority") ?? 2);
    const stats = importCsvText(await file.text(), file.name, priority);
    return NextResponse.json(stats);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Import failed" }, { status: 400 });
  }
}
