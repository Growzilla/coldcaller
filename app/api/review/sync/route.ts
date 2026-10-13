import { NextResponse } from "next/server";
import { syncPlan, syncToGhl } from "@/lib/review-ghl";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** What a sync would do (no GHL calls). */
export async function GET() {
  return NextResponse.json(syncPlan());
}

/** Push pending verdicts to GHL (tags, ICP Score, GBP Status, notes). Stops cleanly on the daily quota. */
export async function POST() {
  try {
    const result = await syncToGhl();
    return NextResponse.json({ ...result, plan: syncPlan() });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "sync failed" }, { status: 502 });
  }
}
