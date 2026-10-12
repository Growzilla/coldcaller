import { NextResponse } from "next/server";
import {
  CHIPS,
  VERDICTS,
  allReviewed,
  buildModel,
  counts,
  features,
  lastReviewed,
  queue,
  setVerdict,
  skip,
  sourceCounts,
  type Filter,
  type Order,
  type Prospect,
  type Verdict,
} from "@/lib/review";

export const dynamic = "force-dynamic";

/** Never send a personnummer-shaped value to the browser (lib/review already drops them on import). */
function card(p: (Prospect & { fit?: number | null }) | undefined) {
  if (!p) return null;
  return {
    ...p,
    org_number: p.company_type === "EF" ? null : p.org_number,
    trades: p.trades ? (JSON.parse(p.trades) as string[]) : [],
    chips: p.chips ? (JSON.parse(p.chips) as string[]) : [],
    features: features(p),
  };
}

function state(order: Order, f: Filter) {
  const model = buildModel(allReviewed());
  const q = queue(order, f, model, 8);
  return {
    current: card(q[0]),
    upcoming: q.slice(1).map((p) => ({ id: p.id, company: p.company, city: p.city, v2: p.v2, fit: p.fit })),
    last: card(lastReviewed()),
    counts: counts(f),
    sources: sourceCounts(),
    chips: CHIPS,
    model: {
      reviewed: model.reviewed,
      good: model.good,
      maybe: model.maybe,
      bad: model.bad,
      ready: model.ready,
      top: model.patterns.slice(0, 8),
      bottom: model.patterns.slice(-8).reverse(),
      chipStats: model.chipStats,
    },
    order: order === "learned" && model.ready ? "learned" : "v2",
  };
}

function filterFrom(o: { source?: unknown; ghl?: unknown }): Filter {
  const ghl = o.ghl === "in" || o.ghl === "out" ? o.ghl : null;
  return { source: o.source ? String(o.source) : null, ghl };
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  return NextResponse.json(state(q.get("order") === "learned" ? "learned" : "v2", filterFrom({ source: q.get("source"), ghl: q.get("ghl") })));
}

/** {action: "verdict", id, verdict, chips, note} · {action: "skip", id} · {action: "undo", id} */
export async function POST(req: Request) {
  const b = await req.json().catch(() => ({} as any));
  const id = Number(b.id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "id required" }, { status: 400 });
  if (b.action === "verdict") {
    if (!VERDICTS.includes(b.verdict)) return NextResponse.json({ error: "verdict must be good|maybe|bad" }, { status: 400 });
    setVerdict(id, b.verdict as Verdict, Array.isArray(b.chips) ? b.chips.map(String) : [], b.note ? String(b.note) : null);
  } else if (b.action === "skip") {
    skip(id);
  } else if (b.action === "undo") {
    setVerdict(id, null, [], null);
  } else {
    return NextResponse.json({ error: "action must be verdict|skip|undo" }, { status: 400 });
  }
  return NextResponse.json(state(b.order === "learned" ? "learned" : "v2", filterFrom(b)));
}
