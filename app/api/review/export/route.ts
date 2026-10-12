import { NextResponse } from "next/server";
import { writeImportFile } from "@/lib/review";

export const dynamic = "force-dynamic";

/** Write good + maybe prospects that aren't in GHL yet as a leads-engine import file. */
export async function POST() {
  const { file, rows } = writeImportFile();
  return NextResponse.json({
    file,
    rows,
    command: rows ? `~/.claude/skills/ghl/ghl.sh cli import --leads-engine ${file} --live` : null,
  });
}
