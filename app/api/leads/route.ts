import { NextResponse } from "next/server";
import { insertLeadStmt } from "@/lib/import";
import { listLeads } from "@/lib/db";
import { toE164 } from "@/lib/phone";

export const dynamic = "force-dynamic";

// Bearer-authed on hosted deploys via middleware.ts (DIALER_API_TOKEN). Open locally.

const naLike = (c?: string | null) => /canada|united states|^us$|\bus\b|north america/i.test(c || "");

/** GET /api/leads?status=&country=&source=&limit= — query the lead list. */
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const leads = listLeads({
    status: p.get("status"),
    country: p.get("country"),
    source: p.get("source"),
    limit: Number(p.get("limit")) || 100,
  });
  return NextResponse.json({ count: leads.length, leads });
}

/**
 * POST /api/leads — structured lead insert for HermesAgent's scraper/enricher.
 * Complements the CSV path (POST /api/leads/import). Idempotent: leads dedupe on
 * (company, phone_e164), so re-pushing is safe.
 *
 * Body: a single lead object OR { leads: [ ... ] }. Per lead:
 *   company (required), first_name, last_name, title,
 *   phone (or phone_e164 / direct_dial / mobile_or_best), email, linkedin, website,
 *   city, country, industry, employees,
 *   priority (0 callback-due | 1 high-value | 2 standard; controls dial order, default 2),
 *   prior_notes (or notes — the DM intro / angle shown on the lead card),
 *   source (label saved as source_file; default "hermes_api").
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const rows: any[] = Array.isArray(body)
    ? body
    : Array.isArray((body as any)?.leads)
      ? (body as any).leads
      : [body];

  const insert = insertLeadStmt();
  let inserted = 0;
  let duplicate = 0;
  const skipped: string[] = [];

  for (const r of rows) {
    const company = (r?.company || "").toString().trim();
    if (!company) {
      skipped.push("(row missing company)");
      continue;
    }
    const defaultCountry = naLike(r.country) ? "NA" : "SE";
    const phone = toE164(r.phone ?? r.phone_e164 ?? r.direct_dial ?? r.mobile_or_best, defaultCountry);
    if (!phone) {
      skipped.push(`${company}: no dialable phone`);
      continue;
    }
    const res = insert.run({
      first_name: r.first_name || null,
      last_name: r.last_name || null,
      title: r.title || null,
      company,
      phone_e164: phone,
      email: r.email || null,
      linkedin: r.linkedin || null,
      website: r.website || null,
      city: r.city || null,
      country: r.country || null,
      industry: r.industry || null,
      employees: r.employees != null ? String(r.employees) : null,
      source_file: (r.source || "hermes_api").toString().slice(0, 120),
      priority: Number.isFinite(+r.priority) ? Math.trunc(+r.priority) : 2,
      prior_notes: r.prior_notes || r.notes || null,
    });
    if (res.changes) inserted += res.changes;
    else duplicate++;
  }

  return NextResponse.json({
    received: rows.length,
    inserted,
    duplicate,
    skipped: skipped.length,
    skippedDetail: skipped.slice(0, 25),
  });
}
