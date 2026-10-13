import { config } from "./config";
import { getDb, type Lead } from "./db";
import { getOperatorPhone } from "./provider";
import { reviewDb } from "./review";

/**
 * GoHighLevel sync. GHL is the lead master: the morning queue is PULLED from the operator's open
 * opportunities in the dialable stages, and every wrapup is PUSHED back (contact upsert, stage
 * move, tags, call note, AI summary note). Auth = sub-account Private Integration Token.
 *
 * Every entry point is best-effort and never throws into the dialer: a GHL outage must never
 * block the next dial. Failures land in calls.ghl_error and the console.
 *
 * Call logs / SMS in GHL *Conversations* need a Marketplace-app conversation provider
 * (conversationProviderId) — that's phase 2; this module uses notes + stages + tags only.
 */

const BASE = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28";

/** Stage names in the GHL pipeline (create them in this order in GHL → Opportunities → Pipelines). */
export const STAGES = {
  newLead: "New Lead",
  attempted: "Attempted",
  callback: "Callback",
  interested: "Interested",
  booked: "Meeting Booked",
} as const;

/** Stages whose open opportunities belong in the calling queue. */
const DIALABLE = [STAGES.newLead, STAGES.attempted, STAGES.callback];

type Outcome = "no_answer" | "callback" | "interested" | "not_interested" | "bad_number" | "booked";

/** Wrapup → where the opportunity goes. stage=null keeps the current stage. */
const OUTCOME_MAP: Record<Outcome, { stage: string | null; status: "open" | "lost"; tags: string[] }> = {
  no_answer: { stage: STAGES.attempted, status: "open", tags: ["cc-no-answer"] },
  callback: { stage: STAGES.callback, status: "open", tags: ["cc-callback"] },
  interested: { stage: STAGES.interested, status: "open", tags: ["cc-interested"] },
  not_interested: { stage: null, status: "lost", tags: ["cc-not-interested"] },
  bad_number: { stage: null, status: "lost", tags: ["cc-bad-number"] },
  booked: { stage: STAGES.booked, status: "open", tags: ["cc-booked"] },
};

const OUTCOME_LABEL: Record<Outcome, string> = {
  no_answer: "No answer",
  callback: "Callback",
  interested: "Interested",
  not_interested: "Not interested",
  bad_number: "Bad number",
  booked: "Meeting booked",
};

export function ghlEnabled(): boolean {
  return Boolean(config.ghlToken && config.ghlLocationId);
}

async function ghl<T = any>(path: string, init: { method?: string; body?: unknown; query?: Record<string, string | number | undefined> } = {}): Promise<T> {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  // 100 req / 10 s per location, shared with bulk imports → back off on 429 instead of failing.
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${config.ghlToken}`,
        Version: API_VERSION,
        Accept: "application/json",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
    if (res.status !== 429 || attempt >= 5) break;
    const wait = Number(res.headers.get("retry-after")) || Math.min(2 ** attempt, 8);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL ${init.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

// ── Pipeline lookup ─────────────────────────────────────────────────────────

type Pipeline = { id: string; name: string; stages: { id: string; name: string; position: number }[] };

declare global {
  // eslint-disable-next-line no-var
  var __ghlPipeline: Pipeline | undefined;
}

export async function getPipeline(): Promise<Pipeline> {
  if (globalThis.__ghlPipeline) return globalThis.__ghlPipeline;
  const data = await ghl<{ pipelines: Pipeline[] }>("/opportunities/pipelines", {
    query: { locationId: config.ghlLocationId },
  });
  const want = config.ghlPipelineName.trim().toLowerCase();
  const p = data.pipelines.find((x) => x.name.trim().toLowerCase() === want);
  if (!p) {
    throw new Error(
      `GHL pipeline "${config.ghlPipelineName}" not found (have: ${data.pipelines.map((x) => x.name).join(", ") || "none"})`
    );
  }
  globalThis.__ghlPipeline = p;
  return p;
}

function stageId(p: Pipeline, name: string): string | undefined {
  const want = name.toLowerCase();
  return p.stages.find((s) => s.name.trim().toLowerCase() === want)?.id;
}

/** Stage names the pipeline is missing — `npm run ghl -- check` reports these. */
export async function missingStages(): Promise<string[]> {
  const p = await getPipeline();
  return Object.values(STAGES).filter((n) => !stageId(p, n));
}

// ── Contacts / opportunities ────────────────────────────────────────────────

const COUNTRY_CODES: Record<string, string> = {
  sweden: "SE", sverige: "SE", norway: "NO", denmark: "DK", finland: "FI", iceland: "IS",
  "united states": "US", usa: "US", canada: "CA", "united kingdom": "GB", germany: "DE",
};

function countryCode(c: string | null): string | undefined {
  if (!c) return undefined;
  const s = c.trim();
  if (/^[A-Z]{2}$/.test(s)) return s;
  return COUNTRY_CODES[s.toLowerCase()];
}

/** Upsert the lead as a GHL contact; caches the id on the lead row. */
export async function ensureContact(lead: Lead): Promise<string> {
  if (lead.ghl_contact_id) return lead.ghl_contact_id;
  const data = await ghl<{ contact: { id: string } }>("/contacts/upsert", {
    method: "POST",
    body: {
      locationId: config.ghlLocationId,
      firstName: lead.first_name ?? undefined,
      lastName: lead.last_name ?? undefined,
      name: [lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.company,
      companyName: lead.company,
      phone: lead.phone_e164 ?? undefined,
      email: lead.email ?? undefined,
      website: lead.website ?? undefined,
      city: lead.city ?? undefined,
      country: countryCode(lead.country),
      source: "coldcaller",
      tags: ["coldcaller"],
    },
  });
  const id = data.contact.id;
  getDb().prepare("UPDATE leads SET ghl_contact_id=? WHERE id=?").run(id, lead.id);
  lead.ghl_contact_id = id;
  return id;
}

/** Move the lead's opportunity per the outcome. Never moves an opportunity BACKWARD in the pipeline. */
async function applyOutcome(lead: Lead, contactId: string, outcome: Outcome): Promise<void> {
  const p = await getPipeline();
  const rule = OUTCOME_MAP[outcome];
  let targetStage = rule.stage ? stageId(p, rule.stage) : undefined;

  let current: { id: string; pipelineStageId: string } | undefined;
  if (lead.ghl_opportunity_id) {
    current = await ghl<{ opportunity: { id: string; pipelineStageId: string } }>(
      `/opportunities/${lead.ghl_opportunity_id}`
    ).then((d) => d.opportunity, () => undefined);
  }
  const pos = (id?: string) => p.stages.find((s) => s.id === id)?.position ?? -1;
  if (current && targetStage && pos(targetStage) < pos(current.pipelineStageId)) targetStage = undefined;
  // A brand-new opportunity needs SOME stage — park it in New Lead when the outcome keeps the stage.
  if (!current && !targetStage) targetStage = stageId(p, STAGES.newLead) ?? p.stages[0]?.id;

  const data = await ghl<{ opportunity: { id: string } }>("/opportunities/upsert", {
    method: "POST",
    body: {
      ...(current ? { id: current.id } : {}),
      locationId: config.ghlLocationId,
      pipelineId: p.id,
      contactId,
      name: lead.company,
      status: rule.status,
      ...(targetStage ? { pipelineStageId: targetStage } : {}),
      ...(config.ghlUserId ? { assignedTo: config.ghlUserId } : {}),
    },
  });
  if (data.opportunity?.id && data.opportunity.id !== lead.ghl_opportunity_id) {
    getDb().prepare("UPDATE leads SET ghl_opportunity_id=? WHERE id=?").run(data.opportunity.id, lead.id);
    lead.ghl_opportunity_id = data.opportunity.id;
  }

  await ghl(`/contacts/${contactId}/tags`, { method: "POST", body: { tags: rule.tags } });
}

async function addNote(contactId: string, body: string): Promise<void> {
  await ghl(`/contacts/${contactId}/notes`, {
    method: "POST",
    body: { body, ...(config.ghlUserId ? { userId: config.ghlUserId } : {}) },
  });
}

type CallJoin = {
  id: number;
  lead_id: number;
  started_at: string;
  duration_s: number | null;
  outcome: string | null;
  notes: string | null;
  analysis: string | null;
  ghl_synced_at: string | null;
  ghl_intel_synced_at: string | null;
};

function parseAnalysis(raw: string | null): { summary?: string; next_step?: string; interest?: number; objections?: string[] } | null {
  if (!raw) return null;
  try {
    const a = JSON.parse(raw);
    return a && !a.error ? a : null;
  } catch {
    return null;
  }
}

function intelText(a: NonNullable<ReturnType<typeof parseAnalysis>>): string {
  return [
    a.summary && `🤖 ${a.summary}`,
    typeof a.interest === "number" && `Interest: ${a.interest}/5`,
    a.objections?.length && `Objections: ${a.objections.join("; ")}`,
    a.next_step && `Next step: ${a.next_step}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function recordError(callId: number, err: unknown): void {
  const msg = String((err as any)?.message || err).slice(0, 500);
  console.warn(`[ghl] call ${callId}: ${msg}`);
  getDb().prepare("UPDATE calls SET ghl_error=? WHERE id=?").run(msg, callId);
}

/**
 * Push one wrapped-up call to GHL: contact, stage move, tags, and a call note (with the AI
 * summary when it's already in). Fire-and-forget from /api/outcome.
 */
export async function syncCall(callId: number): Promise<void> {
  if (!ghlEnabled()) return;
  const db = getDb();
  const call = db.prepare("SELECT * FROM calls WHERE id=?").get(callId) as CallJoin | undefined;
  if (!call?.outcome || !(call.outcome in OUTCOME_MAP)) return;
  const lead = db.prepare("SELECT * FROM leads WHERE id=?").get(call.lead_id) as Lead | undefined;
  if (!lead) return;
  // Self-test calls to the operator's own mobile never become CRM contacts.
  if (lead.phone_e164 && lead.phone_e164 === getOperatorPhone()) return;

  try {
    const contactId = await ensureContact(lead);
    const outcome = call.outcome as Outcome;
    await applyOutcome(lead, contactId, outcome);

    const intel = parseAnalysis(call.analysis);
    const dur = call.duration_s ? ` · ${Math.floor(call.duration_s / 60)}m${String(call.duration_s % 60).padStart(2, "0")}s` : "";
    const note = [
      `📞 Cold call — ${OUTCOME_LABEL[outcome]}${dur}`,
      `${call.started_at} UTC · RapidDial call #${call.id}`,
      call.notes && `Notes: ${call.notes}`,
      intel && intelText(intel),
    ]
      .filter(Boolean)
      .join("\n");
    await addNote(contactId, note);

    db.prepare(
      `UPDATE calls SET ghl_synced_at=datetime('now'), ghl_error=NULL${intel ? ", ghl_intel_synced_at=datetime('now')" : ""} WHERE id=?`
    ).run(callId);
  } catch (err) {
    recordError(callId, err);
  }
}

/**
 * The AI summary usually lands AFTER the wrapup (transcription takes a few seconds). Called from
 * processCall when analysis is stored: adds the summary note if the call note went out without it.
 */
export async function syncIntel(callId: number): Promise<void> {
  if (!ghlEnabled()) return;
  const db = getDb();
  const call = db.prepare("SELECT * FROM calls WHERE id=?").get(callId) as CallJoin | undefined;
  if (!call?.ghl_synced_at || call.ghl_intel_synced_at) return; // not pushed yet (syncCall will include it) or already done
  const intel = parseAnalysis(call.analysis);
  const lead = db.prepare("SELECT * FROM leads WHERE id=?").get(call.lead_id) as Lead | undefined;
  if (!intel || !lead?.ghl_contact_id) return;
  try {
    await addNote(lead.ghl_contact_id, `AI call summary — RapidDial call #${call.id}\n${intelText(intel)}`);
    db.prepare("UPDATE calls SET ghl_intel_synced_at=datetime('now') WHERE id=?").run(callId);
  } catch (err) {
    recordError(callId, err);
  }
}

/** Region tag for splitting leads between cofounders (GHL smart lists / assignment workflows). */
function regionTag(country: string | null): string {
  const code = countryCode(country);
  return code ? `region-${code.toLowerCase()}` : "region-unknown";
}

/**
 * Seed GHL from a local lead, placed by its CALL HISTORY (last outcome → stage/status, same map
 * as live wrapups), with a history note so nothing learned on past calls is lost.
 * Used by `npm run ghl -- push` to migrate the dialer list into GHL.
 */
export async function seedLead(lead: Lead): Promise<{ stage: string; status: string }> {
  const p = await getPipeline();
  const db = getDb();
  const calls = db
    .prepare("SELECT * FROM calls WHERE lead_id=? AND outcome IS NOT NULL ORDER BY id")
    .all(lead.id) as CallJoin[];
  const last = calls[calls.length - 1]?.outcome as Outcome | undefined;
  const rule = last && last in OUTCOME_MAP ? OUTCOME_MAP[last] : null;
  const stageName = rule?.stage ?? STAGES.newLead;
  const sid = stageId(p, stageName);
  if (!sid) throw new Error(`Pipeline "${p.name}" has no "${stageName}" stage`);
  const status = rule?.status ?? "open";

  const contactId = await ensureContact(lead);
  const data = await ghl<{ opportunity: { id: string } }>("/opportunities/upsert", {
    method: "POST",
    body: {
      locationId: config.ghlLocationId,
      pipelineId: p.id,
      pipelineStageId: sid,
      contactId,
      name: lead.company,
      status,
      ...(config.ghlUserId ? { assignedTo: config.ghlUserId } : {}),
    },
  });
  db.prepare("UPDATE leads SET ghl_opportunity_id=? WHERE id=?").run(data.opportunity.id, lead.id);

  const tags = [regionTag(lead.country), ...(rule?.tags ?? [])];
  if (lead.source_file) tags.push(`src-${lead.source_file.replace(/\.[a-z]+$/i, "").toLowerCase().slice(0, 40)}`);
  if (lead.status === "parked") tags.push("parked");
  await ghl(`/contacts/${contactId}/tags`, { method: "POST", body: { tags } });

  const history = calls.map((c) => {
    const intel = parseAnalysis(c.analysis);
    return [
      `• ${c.started_at} — ${OUTCOME_LABEL[c.outcome as Outcome] ?? c.outcome}`,
      c.notes && `  Notes: ${c.notes}`,
      intel?.summary && `  🤖 ${intel.summary}`,
    ]
      .filter(Boolean)
      .join("\n");
  });
  const header = [lead.title && `Title: ${lead.title}`, lead.industry && `Industry: ${lead.industry}`, lead.prior_notes && `Prior notes: ${lead.prior_notes}`]
    .filter(Boolean)
    .join("\n");
  if (history.length || header) {
    await addNote(contactId, [`📥 Imported from RapidDial (${calls.length} past calls)`, header, ...history].filter(Boolean).join("\n"));
  }
  // Mark past calls as synced so `resync` never re-posts them.
  db.prepare("UPDATE calls SET ghl_synced_at=COALESCE(ghl_synced_at, datetime('now')) WHERE lead_id=? AND outcome IS NOT NULL").run(lead.id);
  return { stage: stageName, status };
}

/** Calendly booking detected (lib/calendly.ts) → Meeting Booked stage + note. */
export async function markBooked(leadId: number, startTime: string): Promise<void> {
  if (!ghlEnabled()) return;
  const lead = getDb().prepare("SELECT * FROM leads WHERE id=?").get(leadId) as Lead | undefined;
  if (!lead) return;
  try {
    const contactId = await ensureContact(lead);
    await applyOutcome(lead, contactId, "booked");
    await addNote(contactId, `🎉 Meeting booked (Calendly) for ${startTime}`);
  } catch (err) {
    console.warn(`[ghl] markBooked lead ${leadId}: ${String((err as any)?.message || err)}`);
  }
}

// ── Queue pull (GHL → dialer) ───────────────────────────────────────────────

type GhlOpp = {
  id: string;
  name?: string;
  pipelineStageId: string;
  assignedTo?: string;
  contact?: { id: string; name?: string; companyName?: string; email?: string; phone?: string; tags?: string[] };
  contactId?: string;
};

export type PullStats = {
  fetched: number;
  inserted: number;
  linked: number;
  requeued: number;
  noPhone: number;
  /** Sole traders (nix-required) held out of the queue until NIX-washed. */
  nixHeld: number;
  /** Leads whose exact ICP score / website / city came back from the contact search. */
  scored: number;
};

/**
 * Best-first: leads-engine tags carry the ICP tier. Used as the score until the exact ICP Score
 * custom field arrives from enrichScores() (tiers are cut from that same score, so the order agrees).
 */
const TIER_SCORE: Record<string, number> = {
  "icp:a-sell-now": 110,
  "icp:b-strong": 90,
  "icp:c-ok": 70,
  "icp:d-low": 50,
};

function tierScore(tags: string[] | undefined): number | null {
  let best: number | null = null;
  for (const t of tags ?? []) if (t in TIER_SCORE) best = Math.max(best ?? 0, TIER_SCORE[t]);
  return best;
}

/** GHL custom field ids (Anvil Systems contact fields, see ~/.claude/skills/ghl/CONTEXT.md). */
const FIELD = {
  icpScore: "tDMyf4D4VDlN5B2DT0o6",
  trades: "jvYz0YMllQdheQD79ZTO",
  years: "YRzllx8I0zugZj9PvYNe",
  websiteStatus: "C94ymQXL6ijHp7qZGrBH",
};

/** A lead dialed less than this long ago stays out of the queue even if GHL still says "Attempted". */
const REDIAL_AFTER_HOURS = 20;

/**
 * Pull this operator's open opportunities in the dialable stages into the local queue.
 * Callback stage → priority 0 (top of queue). Leads already dialed recently are not re-queued.
 */
export async function pullQueue(): Promise<PullStats> {
  const stats: PullStats = { fetched: 0, inserted: 0, linked: 0, requeued: 0, noPhone: 0, nixHeld: 0, scored: 0 };
  if (!ghlEnabled()) throw new Error("GHL sync is off — set GHL_PRIVATE_TOKEN and GHL_LOCATION_ID in .env.local");
  const p = await getPipeline();
  const db = getDb();

  const insert = db.prepare(`
    INSERT OR IGNORE INTO leads (first_name, last_name, company, phone_e164, email, country, source_file, priority,
                                 status, score, ghl_contact_id, ghl_opportunity_id)
    VALUES (@first_name, @last_name, @company, @phone_e164, @email, @country, 'ghl', @priority,
            @status, @score, @ghl_contact_id, @ghl_opportunity_id)`);
  const setScore = db.prepare("UPDATE leads SET score=COALESCE(score, ?) WHERE id=?");
  const byContact = db.prepare("SELECT * FROM leads WHERE ghl_contact_id=?");
  const byPhone = db.prepare("SELECT * FROM leads WHERE phone_e164=? AND ghl_contact_id IS NULL ORDER BY id DESC LIMIT 1");
  const link = db.prepare("UPDATE leads SET ghl_contact_id=?, ghl_opportunity_id=? WHERE id=?");
  const lastCall = db.prepare("SELECT MAX(started_at) t FROM calls WHERE lead_id=?");
  const requeue = db.prepare("UPDATE leads SET status='queued', priority=? WHERE id=?");
  const hold = db.prepare("UPDATE leads SET status='nix_hold' WHERE id=? AND status='queued'");
  // Lead review (/review) judged it bad → out of the queue for good, not re-queued after 20 h.
  const holdBad = db.prepare("UPDATE leads SET status='review_bad' WHERE id=? AND status!='review_bad'");

  for (const stageName of DIALABLE) {
    const sid = stageId(p, stageName);
    if (!sid) continue;
    // Callbacks first, then GHL leads (1) ahead of legacy CSV rows (2); score orders within a priority.
    const priority = stageName === STAGES.callback ? 0 : 1;
    let cursor: { startAfter?: string; startAfterId?: string } = {};
    for (let page = 0; page < 50; page++) {
      const data = await ghl<{ opportunities: GhlOpp[]; meta?: { startAfter?: number | string; startAfterId?: string } }>(
        "/opportunities/search",
        {
          query: {
            location_id: config.ghlLocationId,
            pipeline_id: p.id,
            pipeline_stage_id: sid,
            assigned_to: config.ghlUserId || undefined,
            status: "open",
            limit: 100,
            startAfter: cursor.startAfter,
            startAfterId: cursor.startAfterId,
          },
        }
      );
      const opps = data.opportunities ?? [];
      for (const o of opps) {
        stats.fetched++;
        const c = o.contact;
        const contactId = c?.id ?? o.contactId;
        const phone = c?.phone?.trim() || null;
        if (!contactId || !phone) {
          stats.noPhone++;
          continue;
        }
        const tags = c?.tags ?? [];
        const nix = tags.includes("nix-required") && !config.ghlIncludeNix;
        if (nix) stats.nixHeld++;
        const reviewBad = tags.includes("review-bad") || tags.includes("review:bad");
        let lead = byContact.get(contactId) as Lead | undefined;
        if (!lead) {
          // Same person imported by CSV before GHL was wired in → link instead of duplicating.
          const legacy = byPhone.get(phone) as Lead | undefined;
          if (legacy) {
            link.run(contactId, o.id, legacy.id);
            stats.linked++;
            lead = { ...legacy, ghl_contact_id: contactId };
          }
        }
        if (!lead) {
          // Leads-engine contacts are companies (whole name in firstName) — no person to split.
          const company = c?.companyName || c?.name || o.name || phone;
          const res = insert.run({
            first_name: null,
            last_name: null,
            company,
            phone_e164: phone,
            email: c?.email ?? null,
            country: phone.startsWith("+46") ? "Sweden" : null,
            priority,
            status: reviewBad ? "review_bad" : nix ? "nix_hold" : "queued",
            score: tierScore(tags),
            ghl_contact_id: contactId,
            ghl_opportunity_id: o.id,
          });
          stats.inserted += res.changes;
          continue;
        }
        setScore.run(tierScore(tags), lead.id);
        if (reviewBad) {
          holdBad.run(lead.id);
          continue;
        }
        if (nix) {
          hold.run(lead.id);
          continue;
        }
        if (lead.status !== "queued") {
          const t = (lastCall.get(lead.id) as { t: string | null }).t;
          const ageH = t ? (Date.now() - Date.parse(t.replace(" ", "T") + "Z")) / 3.6e6 : Infinity;
          if (ageH >= REDIAL_AFTER_HOURS) {
            requeue.run(priority, lead.id);
            stats.requeued++;
          }
        }
      }
      if (opps.length < 100 || !data.meta?.startAfterId) break;
      cursor = { startAfter: String(data.meta.startAfter ?? ""), startAfterId: data.meta.startAfterId };
    }
  }
  try {
    stats.scored = await enrichScores();
  } catch (err) {
    // Tier scores from tags already order the queue; exact scores are a refinement.
    console.warn(`[ghl] enrichScores: ${String((err as any)?.message || err)}`);
  }
  return stats;
}

type GhlContact = {
  id: string;
  website?: string | null;
  city?: string | null;
  customFields?: { id: string; value: unknown }[];
};

/**
 * Pull exact ICP score + website/city/trades for the GHL leads in the local queue, 100 contacts
 * per request (contacts/search returns custom fields; opportunity search doesn't).
 */
export async function enrichScores(): Promise<number> {
  const db = getDb();
  const linked = db.prepare("SELECT COUNT(*) n FROM leads WHERE ghl_contact_id IS NOT NULL").get() as { n: number };
  if (!linked.n) return 0;
  reviewDb(); // the prospects table must exist for the rank_score lookup below
  // Lead review (/review) owns the order when it has ranked the lead: said-good first, said-bad last.
  const update = db.prepare(`
    UPDATE leads SET score=COALESCE((SELECT rank_score FROM prospects WHERE phone=leads.phone_e164), @score, score),
                     website=COALESCE(website, @website), city=COALESCE(city, @city),
                     industry=COALESCE(@trades, industry), prior_notes=COALESCE(prior_notes, @notes)
    WHERE ghl_contact_id=@id`);
  let n = 0;
  let searchAfter: unknown[] | undefined;
  for (let page = 0; page < 100; page++) {
    const data = await ghl<{ contacts: (GhlContact & { searchAfter?: unknown[] })[] }>("/contacts/search", {
      method: "POST",
      body: { locationId: config.ghlLocationId, pageLimit: 100, ...(searchAfter ? { searchAfter } : {}) },
    });
    const contacts = data.contacts ?? [];
    for (const c of contacts) {
      const f = (id: string) => c.customFields?.find((x) => x.id === id)?.value;
      const score = Number(f(FIELD.icpScore));
      const years = f(FIELD.years);
      const site = f(FIELD.websiteStatus);
      const notes = [years != null && years !== "" && `${years} yrs in business`, site && `Website: ${site}`]
        .filter(Boolean)
        .join(" · ");
      n += update.run({
        id: c.id,
        score: Number.isFinite(score) && score > 0 ? score : null,
        website: c.website || null,
        city: c.city || null,
        trades: (f(FIELD.trades) as string) || null,
        notes: notes || null,
      }).changes;
    }
    if (contacts.length < 100) break;
    searchAfter = contacts[contacts.length - 1].searchAfter;
    if (!searchAfter) break;
  }
  return n;
}

/** Reset the cached pipeline (after renaming stages in GHL without restarting the server). */
export function clearPipelineCache(): void {
  globalThis.__ghlPipeline = undefined;
}
