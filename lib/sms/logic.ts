/** Pure rules for the SMS campaign worker. No database and no network. */

export type NumberKind = "mobile" | "landline" | "service" | "unknown" | "foreign";

export type SegmentRule = { field: string; op: "eq" | "contains" | "neq"; value: string };
export type Segment = { match: "all" | "any"; rules: SegmentRule[] };

export type Classification = "positive" | "negative" | "question" | "opt_out" | "other";

const MOBILE_PREFIXES = ["70", "71", "72", "73", "76", "79"];

/** PTS-style split. 075 personal numbering and 010/020 company numbers are not campaign mobiles. */
export function swedishNumberKind(e164: string | null | undefined): NumberKind {
  if (!e164 || !e164.startsWith("+")) return "unknown";
  const digits = e164.slice(1);
  if (!/^\d{8,15}$/.test(digits)) return "unknown";
  if (!digits.startsWith("46")) return "foreign";
  const national = digits.slice(2);
  if (national.length < 7 || national.length > 12) return "unknown";
  if (MOBILE_PREFIXES.some((p) => national.startsWith(p)) && national.length === 9) return "mobile";
  if (/^(10|20|74|75|77|78|90|93|99)/.test(national)) return "service";
  if (/^7/.test(national)) return "service";
  return "landline";
}

export function hittaSearchUrl(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  const national = digits.startsWith("46") ? "0" + digits.slice(2) : digits;
  return `https://www.hitta.se/s%C3%B6k?vad=${encodeURIComponent(national)}`;
}

export function numberVisibleInText(text: string, e164: string): boolean {
  const digits = e164.replace(/\D/g, "");
  const national = digits.startsWith("46") ? digits.slice(2) : digits;
  const local = "0" + national;
  const compact = text.replace(/[\s\-().]/g, "");
  return compact.includes(local) || compact.includes(digits);
}

export type HittaParse = {
  personNames: string[];
  companyNames: string[];
  exactNumberVisible: boolean;
};

function stripTags(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Pull person and company names out of a hitta.se search page. Footer "most searched" is ignored. */
export function parseHittaHtml(html: string, e164: string): HittaParse {
  const cut = html.split(/Sveriges mest sökta/i)[0] ?? html;
  const personNames: string[] = [];
  const companyNames: string[] = [];
  const h2 = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
  let m: RegExpExecArray | null;
  while ((m = h2.exec(cut))) {
    const name = stripTags(m[1]).replace(/\s+\d{2}$/, "").trim();
    if (!name || name.length > 80 || name.length < 2) continue;
    const before = cut.slice(Math.max(0, m.index - 600), m.index);
    if (/\/(?:foretag|f%C3%B6retag|företag)\//i.test(before)) companyNames.push(name);
    else personNames.push(name);
  }
  return {
    personNames,
    companyNames,
    exactNumberVisible: numberVisibleInText(cut, e164),
  };
}

export function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function matchPersonName(leadName: string, listed: string[]): string | null {
  const tokens = fold(leadName)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
  if (!tokens.length) return null;
  for (const name of listed) {
    const f = fold(name);
    if (tokens.every((t) => f.includes(t))) return name;
  }
  return null;
}

export type ListingJudgement = {
  ownerMatch: boolean | null;
  eligible: boolean;
  switchboard: boolean;
  ownerName: string | null;
  detail: string;
};

export function judgeListing(input: {
  kind: NumberKind;
  parsed: HittaParse;
  leadName: string;
}): ListingJudgement {
  const { kind, parsed } = input;
  if (kind !== "mobile") {
    const why =
      kind === "landline"
        ? "Landline. Campaigns only send to mobiles."
        : kind === "service"
          ? "Service, switchboard, or personal-number prefix (010, 020, 075, 077). Not a mobile."
          : kind === "foreign"
            ? "Not a Swedish +46 number."
            : "Number could not be classified.";
    return { ownerMatch: false, eligible: false, switchboard: kind === "service", ownerName: null, detail: why };
  }

  const matched = matchPersonName(input.leadName, parsed.personNames);
  if (parsed.exactNumberVisible && matched) {
    return {
      ownerMatch: true,
      eligible: true,
      switchboard: false,
      ownerName: matched,
      detail: `hitta.se shows ${matched} on this mobile.`,
    };
  }
  if (parsed.exactNumberVisible && parsed.companyNames.length > 0 && !matched) {
    return {
      ownerMatch: false,
      eligible: false,
      switchboard: true,
      ownerName: null,
      detail: `hitta.se shows this number on a company listing (${parsed.companyNames[0]}), not ${input.leadName || "a named person"}.`,
    };
  }
  if (matched && !parsed.exactNumberVisible) {
    return {
      ownerMatch: null,
      eligible: false,
      switchboard: false,
      ownerName: matched,
      detail: `hitta.se lists ${matched}, but the full mobile is hidden. Not eligible until the number is confirmed.`,
    };
  }
  if (!parsed.personNames.length && !parsed.companyNames.length) {
    return {
      ownerMatch: null,
      eligible: false,
      switchboard: false,
      ownerName: null,
      detail: "No public hitta.se listing for this number.",
    };
  }
  return {
    ownerMatch: null,
    eligible: false,
    switchboard: false,
    ownerName: matched,
    detail: "hitta.se result was inconclusive. The number stays ineligible.",
  };
}

const TEMPLATE_ALIASES: Record<string, string[]> = {
  namn: ["name", "namn"],
  förnamn: ["first_name", "firstname", "fornamn", "förnamn"],
  efternamn: ["last_name", "lastname", "efternamn"],
  företag: ["company", "foretag", "företag"],
  stad: ["city", "stad"],
  titel: ["title", "titel"],
  telefon: ["phone", "telefon", "phone_e164"],
};

export function fillTemplate(template: string, vars: Record<string, string | null | undefined>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = template.replace(/\{([^{}]+)\}/g, (_all, raw: string) => {
    const key = String(raw).trim();
    const folded = fold(key);
    const direct = vars[key] ?? vars[folded];
    if (direct) return String(direct);
    const aliases = TEMPLATE_ALIASES[folded] ?? [folded];
    for (const alias of aliases) {
      const hit = Object.entries(vars).find(([k, v]) => v && fold(k) === fold(alias));
      if (hit) return String(hit[1]);
    }
    missing.push(key);
    return `{${key}}`;
  });
  return { text, missing };
}

const OPT_OUT = [
  "stop",
  "stopp",
  "sluta",
  "avregistrera",
  "avregistrering",
  "unsubscribe",
  "optout",
  "opt out",
  "ta bort",
  "sluta sms",
  "sluta skicka",
  "avsluta",
];

const POSITIVE = [
  "ja tack",
  "ja garna",
  "ja gärna",
  "intresserad",
  "intresserade",
  "later bra",
  "låter bra",
  "later intressant",
  "låter intressant",
  "beratta mer",
  "berätta mer",
  "ring mig",
  "ring garna",
  "ring gärna",
  "call me",
  "tell me more",
  "skicka info",
  "skicka gärna",
  "absolut",
  "garna",
  "gärna",
  "japp",
  "visst",
  "okej",
  "okay",
  "interested",
  "boka",
  "kor",
  "kör",
  "yes",
  "sure",
  "ja",
  "ok",
  "ring",
];

const NEGATIVE = [
  "inte intresserad",
  "inget intresse",
  "nej tack",
  "no thanks",
  "inte aktuellt",
  "fel person",
  "har redan",
  "nej",
  "no",
];

function normMessage(body: string): string {
  return fold(body)
    .replace(/[!?.,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasPhrase(text: string, phrase: string): boolean {
  const p = fold(phrase);
  if (p.includes(" ")) return text.includes(p);
  return new RegExp(`(?:^|\\s)${p}(?:\\s|$)`).test(text);
}

export function classifyReply(body: string): { classification: Classification; reason: string } {
  const text = normMessage(body);
  if (!text) return { classification: "other", reason: "Empty message." };

  const opt = OPT_OUT.find((p) => text === fold(p) || text.startsWith(fold(p) + " ") || (fold(p).includes(" ") && text.includes(fold(p))));
  if (opt && !(opt.startsWith("sluta") && text.includes("inte"))) {
    return { classification: "opt_out", reason: `Opt-out phrase “${opt}”.` };
  }

  const positive = POSITIVE.find((p) => hasPhrase(text, p));
  const negative = NEGATIVE.find((p) => hasPhrase(text, p));
  if (positive && !negative) return { classification: "positive", reason: `Interested phrase “${positive}”.` };
  if (negative) return { classification: "negative", reason: `Not-interested phrase “${negative}”.` };
  if (body.includes("?") || /^(hur|vad|nar|när|varfor|varför|vilken|vilket|kan ni|what|how|when)\b/.test(text)) {
    return { classification: "question", reason: "Looks like a question." };
  }
  return { classification: "other", reason: "No positive, negative, or opt-out phrase." };
}

export type StockholmClock = { hour: number; minute: number; weekday: string; dateKey: string };

export function stockholmClock(now: Date): StockholmClock {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Stockholm",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return {
    hour,
    minute: Number(parts.minute),
    weekday: parts.weekday,
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

export function stockholmDayBounds(now: Date): { startIso: string; endIso: string; dateKey: string } {
  const { dateKey } = stockholmClock(now);
  // Walk UTC hours until the Stockholm date key changes. The day is at most 24h.
  const start = new Date(now.getTime() - 36 * 3600 * 1000);
  let dayStart: Date | null = null;
  let dayEnd: Date | null = null;
  for (let t = start.getTime(); t < now.getTime() + 36 * 3600 * 1000; t += 60 * 1000) {
    const key = stockholmClock(new Date(t)).dateKey;
    if (key === dateKey && !dayStart) dayStart = new Date(t);
    if (dayStart && key !== dateKey) {
      dayEnd = new Date(t);
      break;
    }
  }
  return {
    startIso: (dayStart ?? now).toISOString(),
    endIso: (dayEnd ?? new Date(now.getTime() + 24 * 3600 * 1000)).toISOString(),
    dateKey,
  };
}

function parseHHMM(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

const WEEKDAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);

export function insideSendWindow(now: Date, windowStart: string, windowEnd: string, weekdaysOnly: boolean): { ok: boolean; reason: string } {
  const clock = stockholmClock(now);
  if (weekdaysOnly && !WEEKDAYS.has(clock.weekday)) {
    return { ok: false, reason: `Outside send days (${clock.weekday}, weekdays only).` };
  }
  const start = parseHHMM(windowStart);
  const end = parseHHMM(windowEnd);
  if (start == null || end == null || end <= start) return { ok: false, reason: "Send window is invalid." };
  const mins = clock.hour * 60 + clock.minute;
  if (mins < start || mins >= end) {
    return { ok: false, reason: `Outside send window ${windowStart}–${windowEnd} Stockholm (now ${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}).` };
  }
  return { ok: true, reason: "Inside window." };
}

export function gapReady(now: Date, lastSendAt: string | null, minGapSeconds: number): { ok: boolean; reason: string } {
  if (!lastSendAt) return { ok: true, reason: "No previous send." };
  const last = Date.parse(lastSendAt);
  if (!Number.isFinite(last)) return { ok: true, reason: "Previous send time unreadable." };
  const wait = minGapSeconds * 1000 - (now.getTime() - last);
  if (wait > 0) return { ok: false, reason: `Pacing: ${Math.ceil(wait / 1000)}s left before the next send.` };
  return { ok: true, reason: "Gap elapsed." };
}

export function contactField(contact: { [key: string]: unknown; extra?: Record<string, string> }, field: string): string {
  const folded = fold(field);
  const direct = contact[folded] ?? contact[field];
  if (direct != null && String(direct).length) return String(direct);
  const extra = contact.extra ?? {};
  const hit = Object.entries(extra).find(([k]) => fold(k) === folded);
  return hit ? String(hit[1] ?? "") : "";
}

export function matchesSegment(contact: { [key: string]: unknown; extra?: Record<string, string> }, segment: Segment): boolean {
  const rules = segment.rules ?? [];
  if (!rules.length) return true;
  const checks = rules.map((rule) => {
    const value = fold(contactField(contact, rule.field));
    const expect = fold(rule.value ?? "");
    if (rule.op === "contains") return expect.length > 0 && value.includes(expect);
    if (rule.op === "neq") return value !== expect;
    return value === expect;
  });
  return segment.match === "any" ? checks.some(Boolean) : checks.every(Boolean);
}

export function parseSegment(raw: unknown): Segment {
  const empty: Segment = { match: "all", rules: [] };
  if (!raw || typeof raw !== "object") return empty;
  const src = raw as { match?: string; rules?: unknown };
  const match = src.match === "any" ? "any" : "all";
  const rules: SegmentRule[] = [];
  if (Array.isArray(src.rules)) {
    for (const rule of src.rules) {
      if (!rule || typeof rule !== "object") continue;
      const r = rule as SegmentRule;
      const op = r.op === "contains" || r.op === "neq" ? r.op : "eq";
      const field = String(r.field ?? "").trim();
      if (!field) continue;
      rules.push({ field, op, value: String(r.value ?? "") });
    }
  }
  return { match, rules };
}

export function hardDailyCap(): number {
  const n = Number(process.env.SMS_HARD_DAILY_CAP || 100);
  if (!Number.isFinite(n)) return 100;
  return Math.min(200, Math.max(1, Math.floor(n)));
}

export function clampDailyLimit(n: number): number {
  const cap = hardDailyCap();
  if (!Number.isFinite(n)) return Math.min(40, cap);
  return Math.min(cap, Math.max(1, Math.floor(n)));
}

export function clampGap(n: number): number {
  if (!Number.isFinite(n)) return 90;
  return Math.min(3600, Math.max(45, Math.floor(n)));
}

export function notificationText(input: {
  kind: "positive" | "call";
  name: string;
  company: string;
  phone: string;
  reply?: string;
  reason?: string;
  url: string;
}): string {
  const who = [input.name, input.company].filter(Boolean).join(", ") || "Okänd";
  const lines =
    input.kind === "call"
      ? [`SAMTAL ${who}`, input.phone, "Ringer VOIP-numret.", input.url]
      : [`POSITIVT ${who}`, input.phone, input.reply ? `"${input.reply}"` : "", input.reason ?? "", input.url];
  return lines
    .filter(Boolean)
    .join("\n")
    .slice(0, 600);
}

export const CONTACT_STATES = ["new", "contacted", "in_conversation", "do_not_contact", "opted_out"] as const;
export type ContactState = (typeof CONTACT_STATES)[number];

export const CAMPAIGN_STATUSES = ["draft", "running", "paused", "cancelled", "completed"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
