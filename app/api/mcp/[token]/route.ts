import crypto from "crypto";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { DIALABLE_MOBILE_SQL } from "@/lib/phone";

/**
 * Read-only MCP server (Streamable HTTP, stateless, JSON responses) so Claude / ChatGPT / any MCP client
 * can ask the dialer: what objections come up, who to call next, which follow-ups are due, a lead's history,
 * dial stats. URL: https://<host>/mcp/<MCP_TOKEN> (Caddy rewrites /mcp/* → /api/mcp/*, outside basic auth).
 * No tool writes anything.
 */
export const dynamic = "force-dynamic";

const PROTOCOL = "2025-06-18";

function tokenOk(token: string): boolean {
  const want = process.env.MCP_TOKEN || "";
  if (!want || !token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

type Tool = { name: string; description: string; inputSchema: Record<string, unknown>; run: (a: any) => unknown };

const int = (v: unknown, d: number, max: number) => Math.min(Math.max(Number(v) || d, 1), max);

const TOOLS: Tool[] = [
  {
    name: "objections_summary",
    description: "Objections prospects raised on recent calls (from the AI call analysis), counted, with company + date for each.",
    inputSchema: { type: "object", properties: { days: { type: "number", description: "Look-back window, default 14" } } },
    run: ({ days }) => {
      const rows = getDb()
        .prepare(
          `SELECT c.started_at, c.outcome, c.analysis, l.company, l.country FROM calls c JOIN leads l ON l.id=c.lead_id
           WHERE c.analysis IS NOT NULL AND c.started_at >= datetime('now', ?) ORDER BY c.id DESC`
        )
        .all(`-${int(days, 14, 365)} days`) as any[];
      const counts: Record<string, { n: number; examples: string[] }> = {};
      for (const r of rows) {
        let a: any;
        try {
          a = JSON.parse(r.analysis);
        } catch {
          continue;
        }
        for (const o of a.objections ?? []) {
          const k = String(o).trim();
          if (!k) continue;
          counts[k] ??= { n: 0, examples: [] };
          counts[k].n++;
          if (counts[k].examples.length < 3) counts[k].examples.push(`${r.company} (${r.country ?? "?"}, ${r.started_at.slice(0, 10)}, ${r.outcome ?? "no outcome"})`);
        }
      }
      return {
        analysed_calls: rows.length,
        objections: Object.entries(counts)
          .sort((x, y) => y[1].n - x[1].n)
          .map(([objection, v]) => ({ objection, count: v.n, examples: v.examples })),
      };
    },
  },
  {
    name: "best_to_call",
    description: "Next leads in the dialer queue, in dial order (callbacks first, then priority + ICP score), with the why-note for each.",
    inputSchema: {
      type: "object",
      properties: {
        n: { type: "number", description: "How many, default 25" },
        source: { type: "string", description: "Lead batch, e.g. se-electricians-v2-20261029 or au-electricians-20261029" },
        country: { type: "string", description: "Sweden, Australia, …" },
      },
    },
    run: ({ n, source, country }) => {
      const where = [`status='queued'`, DIALABLE_MOBILE_SQL, `(snooze_until IS NULL OR snooze_until <= datetime('now'))`];
      const args: unknown[] = [];
      if (source) (where.push("source_file=?"), args.push(source));
      if (country) (where.push("country=?"), args.push(country));
      return getDb()
        .prepare(
          `SELECT id, company, first_name, last_name, title, phone_e164, city, country, industry, score, priority, source_file, prior_notes
           FROM leads WHERE ${where.join(" AND ")} ORDER BY priority, score DESC, id LIMIT ${int(n, 25, 200)}`
        )
        .all(...args);
    },
  },
  {
    name: "followups_due",
    description: "Leads whose last call ended as a callback or interested — who to follow up with, when, and what was said.",
    inputSchema: { type: "object", properties: { include_future: { type: "boolean", description: "Also list callbacks scheduled later" } } },
    run: ({ include_future }) =>
      getDb()
        .prepare(
          `SELECT l.id, l.company, l.first_name, l.last_name, l.phone_e164, l.country, l.snooze_until AS due, c.outcome, c.started_at AS last_call,
                  c.notes, json_extract(c.analysis,'$.next_step') AS next_step, json_extract(c.analysis,'$.summary') AS summary
           FROM leads l JOIN calls c ON c.id = (SELECT MAX(id) FROM calls WHERE lead_id=l.id AND outcome IS NOT NULL)
           WHERE c.outcome IN ('callback','interested') AND l.status NOT IN ('done','skipped','passed')
             ${include_future ? "" : "AND (l.snooze_until IS NULL OR l.snooze_until <= datetime('now','+1 day'))"}
           ORDER BY COALESCE(l.snooze_until, c.started_at)`
        )
        .all(),
  },
  {
    name: "lead_lookup",
    description: "Find a lead by company name or phone and return it with its full call history (outcomes, notes, AI summaries, transcripts).",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    run: ({ query }) => {
      const q = String(query ?? "").trim();
      if (!q) return { error: "query required" };
      const digits = q.replace(/\D/g, "");
      const leads = getDb()
        .prepare(
          `SELECT * FROM leads WHERE company LIKE ? ${digits.length >= 6 ? "OR replace(phone_e164,'+','') LIKE ?" : ""} ORDER BY id DESC LIMIT 5`
        )
        .all(`%${q}%`, ...(digits.length >= 6 ? [`%${digits.slice(-9)}%`] : [])) as any[];
      const calls = getDb().prepare(
        "SELECT id, started_at, duration_s, outcome, notes, analysis, substr(transcript,1,4000) AS transcript FROM calls WHERE lead_id=? ORDER BY id"
      );
      return leads.map((l) => ({ ...l, calls: calls.all(l.id) }));
    },
  },
  {
    name: "call_stats",
    description: "Dial activity per day: dials, connected (answered), outcomes — against the 25-dials/day benchmark.",
    inputSchema: { type: "object", properties: { days: { type: "number", description: "default 14" } } },
    run: ({ days }) =>
      getDb()
        .prepare(
          `SELECT date(started_at) AS day, COUNT(*) AS dials, SUM(answered_at IS NOT NULL) AS answered,
                  SUM(outcome='interested') AS interested, SUM(outcome='callback') AS callbacks,
                  SUM(outcome='not_interested') AS not_interested, SUM(outcome='no_answer') AS no_answer,
                  SUM(outcome='bad_number') AS bad_number, ROUND(SUM(COALESCE(duration_s,0))/60.0,1) AS talk_min,
                  CASE WHEN COUNT(*) >= 25 THEN 'hit' ELSE 'under' END AS vs_25_benchmark
           FROM calls WHERE started_at >= date('now', ?) GROUP BY 1 ORDER BY 1 DESC`
        )
        .all(`-${int(days, 14, 365)} days`),
  },
  {
    name: "recent_calls",
    description: "Most recent calls with company, outcome, notes and the AI one-line summary.",
    inputSchema: { type: "object", properties: { n: { type: "number", description: "default 20" } } },
    run: ({ n }) =>
      getDb()
        .prepare(
          `SELECT c.id, c.started_at, c.duration_s, c.outcome, c.notes, json_extract(c.analysis,'$.summary') AS summary,
                  json_extract(c.analysis,'$.objections') AS objections, l.company, l.phone_e164, l.country, l.source_file
           FROM calls c JOIN leads l ON l.id=c.lead_id ORDER BY c.id DESC LIMIT ${int(n, 20, 200)}`
        )
        .all(),
  },
  {
    name: "queue_overview",
    description: "How many leads are queued per lead batch (source) and country.",
    inputSchema: { type: "object", properties: {} },
    run: () =>
      getDb()
        .prepare(
          `SELECT source_file AS source, country, COUNT(*) AS queued, ROUND(AVG(score),1) AS avg_score FROM leads
           WHERE status='queued' AND ${DIALABLE_MOBILE_SQL} GROUP BY 1,2 ORDER BY 3 DESC`
        )
        .all(),
  },
];

function rpc(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}
function rpcErr(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function handle(msg: any): object | null {
  const { id, method, params } = msg ?? {};
  if (id === undefined || id === null) return null; // notification
  switch (method) {
    case "initialize":
      return rpc(id, {
        protocolVersion: params?.protocolVersion || PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "rapiddial", version: "1.0.0" },
        instructions:
          "Read-only access to the RapidDial cold-calling dialer (Anvil Systems): call outcomes, AI call analyses (objections, next steps), the dial queue and follow-ups.",
      });
    case "ping":
      return rpc(id, {});
    case "tools/list":
      return rpc(id, { tools: TOOLS.map(({ run, ...t }) => t) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return rpcErr(id, -32602, `unknown tool ${params?.name}`);
      try {
        const out = tool.run(params?.arguments ?? {});
        return rpc(id, { content: [{ type: "text", text: JSON.stringify(out, null, 1) }] });
      } catch (e: any) {
        return rpc(id, { content: [{ type: "text", text: `error: ${e?.message ?? e}` }], isError: true });
      }
    }
    default:
      return rpcErr(id, -32601, `method not found: ${method}`);
  }
}

export async function POST(req: Request, { params }: { params: { token: string } }) {
  if (!tokenOk(params.token)) return new NextResponse("Not found", { status: 404 });
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(rpcErr(null, -32700, "parse error"), { status: 400 });
  }
  const out = Array.isArray(body) ? body.map(handle).filter(Boolean) : handle(body);
  if (out === null || (Array.isArray(out) && out.length === 0)) return new NextResponse(null, { status: 202 });
  return NextResponse.json(out);
}

export async function GET(_req: Request, { params }: { params: { token: string } }) {
  if (!tokenOk(params.token)) return new NextResponse("Not found", { status: 404 });
  return new NextResponse("Method not allowed — POST JSON-RPC here", { status: 405, headers: { Allow: "POST" } });
}

export async function DELETE() {
  return new NextResponse(null, { status: 405 });
}
