import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getDb } from "@/lib/db";
import { config } from "@/lib/config";
import { processCall } from "@/lib/intelligence";

export const dynamic = "force-dynamic";

/** Receives the browser's per-call recording, then transcribes + analyzes in the background. */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const callId = Number(params.id);
  const db = getDb();
  const call = db.prepare("SELECT id FROM calls WHERE id=?").get(callId);
  if (!call) return NextResponse.json({ error: "unknown call" }, { status: 404 });

  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length === 0) return NextResponse.json({ error: "empty body" }, { status: 400 });

  const dir = config.recordingsDir;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `call-${callId}.webm`);
  fs.writeFileSync(file, buf);
  db.prepare("UPDATE calls SET recording_path=? WHERE id=?").run(file, callId);

  void processCall(callId); // fire-and-forget — next dial is never blocked
  return NextResponse.json({ ok: true, bytes: buf.length });
}
