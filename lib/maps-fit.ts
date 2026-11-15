import { FIRST_NAMES } from "./lead-tags";

/**
 * Who is worth calling: a trade firm Google does not show for "{trade} {city}".
 *
 * The check is fail-closed. A lead is dialable only with positive evidence:
 *   - a complete Places result for every trade term, and their name is not in it, or
 *   - a direct name search found no Google Business Profile (a profile is what the
 *     map pack is made of, so no profile means they cannot be the firm that shows up).
 * Anything uncertain (name might be the one on screen, the city pack was cut off and
 * they do have a profile, the city was never checked) stays out of the queue.
 *
 * Smaller towns are where a complete pack is the whole market, so those leads sort first.
 * Stockholm-sized searches return a capped list, so absence there is not evidence.
 */

/** Customer search words, not the registry label. Swedish customers type "elektriker Falun". */
export const TRADE_TERMS: Record<string, { sv: string; en: string }> = {
  electrician: { sv: "elektriker", en: "electrician" },
  builder: { sv: "byggfirma", en: "builder" },
  carpentry: { sv: "snickare", en: "carpenter" },
  groundworks: { sv: "markentreprenad", en: "excavation" },
  plumbing: { sv: "rörmokare", en: "plumber" },
  painting: { sv: "målare", en: "painter" },
  flooring: { sv: "golvläggare", en: "flooring" },
  hvac: { sv: "ventilation", en: "hvac" },
  facade: { sv: "fasad", en: "facade" },
  roofing: { sv: "takläggare", en: "roofer" },
  stonework: { sv: "stenhuggeri", en: "stonemason" },
  insulation: { sv: "isolering", en: "insulation" },
  refrigeration: { sv: "kylfirma", en: "refrigeration" },
  "fire-protection": { sv: "brandskydd", en: "fire protection" },
  glazing: { sv: "glasmästare", en: "glazier" },
  elevators: { sv: "hisservice", en: "elevator" },
  solar: { sv: "solceller", en: "solar" },
  landscaper: { sv: "trädgård", en: "landscaper" },
};

/**
 * Sort penalty only. These markets are large enough that "not on the first pages"
 * is normal, so a cleared lead here waits behind a cleared lead in a small town.
 * Folded (lowercase, å/ä/ö stripped) so "Göteborg" and "Goteborg" match.
 */
const BIG_CITIES = new Set(
  [
    // Sweden, municipalities around 100k and up, plus inner Stockholm
    "stockholm", "solna", "sundbyberg", "nacka", "huddinge", "taby", "sollentuna", "jarfalla",
    "tyreso", "vallentuna", "upplands vasby", "akersberga", "osteraker", "varmdo", "lidingo",
    "danderyd", "haninge", "botkyrka", "ekero", "bromma", "hagersten", "vendelso", "gustavsberg",
    "goteborg", "malmo", "uppsala", "linkoping", "vasteras", "orebro", "helsingborg",
    "norrkoping", "jonkoping", "umea", "lund", "boras", "eskilstuna", "gavle", "halmstad",
    "sundsvall", "sodertalje", "vaxjo", "karlstad",
    // Australia capitals and the big coastal cities
    "sydney", "melbourne", "brisbane", "perth", "adelaide", "canberra", "gold coast",
  ].map((c) => c)
);

const GIVEN = new Set([...FIRST_NAMES].map((n) => fold(n)));
const GENERIC = new Set(
  [
    "ab", "hb", "kb", "ef", "aktiebolag", "handelsbolag", "pty", "ltd", "limited", "inc", "llc", "co", "company",
    "el", "elektriska", "elektrisk", "elektriker", "electrician", "electrical", "elteknik", "elservice",
    "elinstallation", "service", "teknik", "montage", "installation", "installator", "installatör",
    "och", "and", "the", "of", "for", "i", "vvs", "bygg", "byggfirma", "snickeri", "snickare",
    "måleri", "målare", "rörmokare", "ventilation", "golv", "golvläggare", "mark", "markentreprenad",
    "firma", "solceller", "solar", "tak", "takläggare", "fasad", "isolering", "entreprenad", "gruppen",
    "group", "sverige", "sweden",
  ].map((w) => fold(w))
);

export type Region = "SE" | "AU" | "OTHER";
export type Gbp = "none" | "present" | "unknown";
export type Fit = "suitable" | "shown" | "ambiguous" | "unproven" | "no_city" | "not_trade" | "pending";
export type NameMatch = "same" | "ambiguous" | "different";

export type Pack = {
  trade: string;
  /** The query we sent, e.g. "elektriker Falun". */
  query: string;
  /** False when Google cut the list off, or returned nobody (not proof of absence). */
  complete: boolean;
  names: string[];
};

export type Decision = {
  fit: Fit;
  reason: string;
  gbp: Gbp;
  /** Lower sorts first among dialable leads. Callbacks are ordered separately. */
  rank: number;
};

export function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/&/g, " och ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "Melbourne, VIC" → "Melbourne". The state suffix must not become part of the query. */
export function cleanCity(city: string): string {
  return city.split(",")[0].trim();
}

export function regionOf(country: string | null | undefined): Region {
  const c = (country ?? "").trim().toLowerCase();
  if (c === "sweden" || c === "se") return "SE";
  if (c === "australia" || c === "au") return "AU";
  return "OTHER";
}

/** Known trade keys in a lead's industry string ("builder, carpentry"). Unknown words are dropped. */
export function tradesOf(industry: string | null | undefined): string[] {
  if (!industry) return [];
  const seen = new Set<string>();
  for (const part of industry.split(",")) {
    const key = part.trim().toLowerCase();
    if (TRADE_TERMS[key]) seen.add(key);
  }
  return [...seen];
}

export function isBigCity(city: string | null | undefined): boolean {
  if (!city) return false;
  return BIG_CITIES.has(fold(cleanCity(city)));
}

export function packQuery(trade: string, city: string, region: Region): string | null {
  const term = TRADE_TERMS[trade];
  if (!term || region === "OTHER") return null;
  return `${region === "SE" ? term.sv : term.en} ${cleanCity(city)}`;
}

export function packKey(trade: string, city: string, region: Region): string | null {
  const q = packQuery(trade, city, region);
  if (!q) return null;
  return `${region}|${trade}|${fold(cleanCity(city))}`;
}

export function gbpKey(company: string, city: string, region: Region): string {
  return `${region}|${fold(company)}|${fold(cleanCity(city))}`;
}

function distinctive(name: string, city: string): string[] {
  const drop = new Set(GENERIC);
  for (const t of fold(cleanCity(city)).split(" ")) if (t) drop.add(t);
  const out: string[] = [];
  for (const t of fold(name).split(" ")) {
    if (t.length < 2 || drop.has(t)) continue;
    out.push(t);
  }
  return out;
}

function prefixClose(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 8 && long.startsWith(short) && long.length - short.length <= 2;
}

function weakPrefix(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 5 && short.length < 8 && long.startsWith(short) && long.length - short.length <= 2;
}

/** One insertion, deletion, or substitution. Used only on long tokens. */
function editAtMost1(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let used = false;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (used) return false;
    used = true;
    if (a.length === b.length) {
      i++;
      j++;
    } else if (a.length > b.length) i++;
    else j++;
  }
  return true;
}

type Hit = "strong" | "weak" | "given";

function tokenHit(a: string, b: string): Hit | null {
  const given = GIVEN.has(a) || GIVEN.has(b);
  const strongShape = a.length >= 6 && b.length >= 6;
  const close = a === b || (strongShape && (editAtMost1(a, b) || prefixClose(a, b)));
  if (close) {
    if (given) return "given";
    if (a.length >= 6 || b.length >= 6) return "strong";
    return "weak";
  }
  if (weakPrefix(a, b)) return "weak";
  return null;
}

/**
 * same: this listing is the lead. ambiguous: it might be, so the lead stays out.
 * different: this listing is someone else (a generic "El i Falun" listing does not count).
 */
export function matchPlace(company: string, place: string, city: string): NameMatch {
  const lead = distinctive(company, city);
  const other = distinctive(place, city);
  if (!lead.length) return "ambiguous";
  if (!other.length) return "different";
  let strong = 0;
  let weak = 0;
  let given = 0;
  for (const a of lead) {
    let best: Hit | null = null;
    for (const b of other) {
      const hit = tokenHit(a, b);
      if (hit === "strong") best = "strong";
      else if (hit === "weak" && best !== "strong") best = "weak";
      else if (hit === "given" && !best) best = "given";
    }
    if (best === "strong") strong++;
    else if (best === "weak") weak++;
    else if (best === "given") given++;
  }
  if (strong >= 1) return "same";
  if (weak >= 2 || (weak >= 1 && given >= 1)) return "same";
  if (weak >= 1) return "ambiguous";
  // "Anders El" vs "Anders Elektriska": the firm has no word of its own, only a first name.
  const leadHasOwnWord = lead.some((t) => !GIVEN.has(t));
  if (given >= 1 && !leadHasOwnWord) return "ambiguous";
  return "different";
}

export function matchPack(company: string, city: string, names: string[]): { match: NameMatch; place: string | null } {
  let ambiguous: string | null = null;
  for (const place of names) {
    const m = matchPlace(company, place, city);
    if (m === "same") return { match: "same", place };
    if (m === "ambiguous" && !ambiguous) ambiguous = place;
  }
  if (ambiguous) return { match: "ambiguous", place: ambiguous };
  return { match: "different", place: null };
}

function quote(q: string): string {
  return `“${q}”`;
}

/**
 * @param gbp result of the direct "{company} {city}" search. null means we have not run it.
 *        Pass null only while planning the run. The stamper always passes a value for leads
 *        that need it, and "unknown" when the lookup itself failed.
 */
export function decideFit(input: {
  company: string;
  city: string | null;
  region: Region;
  trades: string[];
  packs: Pack[];
  gbp: Gbp | null;
}): Decision {
  const gbp: Gbp = input.gbp ?? "unknown";
  const city = input.city?.trim() || "";
  const rankFor = (g: Gbp) => {
    const gRank = g === "none" ? 0 : g === "present" ? 2 : 1;
    return gRank * 2 + (isBigCity(city) ? 1 : 0);
  };
  const base = (fit: Fit, reason: string, g: Gbp = gbp): Decision => ({ fit, reason, gbp: g, rank: rankFor(g) });

  if (!input.trades.length) return base("not_trade", "Not a local trade");
  if (input.region === "OTHER") return base("unproven", "No Google check for this country yet");
  if (!city) return base("no_city", "No city, so there is no “trade + city” search to run");

  const byTrade = new Map(input.packs.map((p) => [p.trade, p]));
  const missing = input.trades.filter((t) => !byTrade.has(t));
  if (missing.length) return base("pending", `Google check not run for ${missing.join(", ")}`);

  let ambiguous: { query: string; place: string } | null = null;
  let clearComplete = true;
  const queries: string[] = [];
  for (const trade of input.trades) {
    const pack = byTrade.get(trade)!;
    queries.push(pack.query);
    const judged = matchPack(input.company, city, pack.names);
    if (judged.match === "same") {
      return base("shown", `Shown on Google for ${quote(pack.query)} (matches “${judged.place}”)`, "present");
    }
    if (judged.match === "ambiguous" && !ambiguous) ambiguous = { query: pack.query, place: judged.place ?? "" };
    if (!pack.complete || pack.names.length === 0) clearComplete = false;
  }

  if (ambiguous) {
    return base("ambiguous", `Might be the Google result “${ambiguous.place}” for ${quote(ambiguous.query)}`);
  }

  const listed = queries.map(quote).join(" and ");
  if (clearComplete) {
    const tail = gbp === "none" ? " · no Business Profile" : gbp === "present" ? " · profile exists, it does not rank" : "";
    return base("suitable", `Not shown on Google for ${listed}${tail}`);
  }

  // The category search was capped or empty. Only a confirmed missing profile is evidence,
  // and only when the company name is distinctive enough to search for.
  if (gbp === "none") {
    if (matchPlace(input.company, input.company, city) === "ambiguous") {
      return base("unproven", "Company name is too generic to prove it is missing from Google");
    }
    return base("suitable", `No Google Business Profile · ${listed} ${queries.length > 1 ? "are" : "is"} too crowded to rank-check`);
  }
  if (gbp === "present") {
    return base("unproven", `Has a Google Business Profile and ${listed} ${queries.length > 1 ? "are" : "is"} too crowded to prove they are absent`);
  }
  return base("unproven", `Not cleared — ${listed} did not prove they are invisible`);
}
