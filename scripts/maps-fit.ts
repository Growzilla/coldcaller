/**
 * Decide which queued leads are invisible on Google, and (with --apply) make the
 * cockpit dial only those.
 *
 *   npm run maps:fit -- --dry-run     how many Places calls a run needs
 *   npm run maps:fit -- --probe       a few real cities, print the decisions, write nothing
 *   npm run maps:fit -- --apply       stamp every queued lead and turn the gate on
 *
 * One Places Text Search per "{trade} {city}" (elektriker Falun), then one name
 * search per lead that the city pack did not already settle. Cached 14 days.
 * --refresh ignores the cache. A lead is stamped suitable only when lib/maps-fit
 * has positive evidence. A failed request is never treated as "not shown".
 */
import { config } from "../lib/config";
import { getDb } from "../lib/db";
import {
  cleanCity,
  decideFit,
  fold,
  gbpKey,
  isBigCity,
  matchPack,
  packKey,
  packQuery,
  regionOf,
  tradesOf,
  type Gbp,
  type Pack,
  type Region,
} from "../lib/maps-fit";
import { ensureMapsSchema, readGbp, readPack, setMapsOnly, stampLead, writeGbp, writePack } from "../lib/maps-store";

const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const DRY = has("--dry-run");
const PROBE = has("--probe");
const APPLY = has("--apply");
const REFRESH = has("--refresh");
const flagValue = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const MAX = Number(flagValue("--max-calls")) || 4500;
const countryArg = flagValue("--country") ?? "";

type LeadRow = { id: number; company: string; city: string | null; country: string | null; industry: string | null };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Page = { names: string[]; nextPageToken?: string };

async function searchPage(query: string, region: Region, pageToken?: string): Promise<Page> {
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": config.googlePlacesKey,
      "X-Goog-FieldMask": "places.displayName,nextPageToken",
    },
    body: JSON.stringify({
      textQuery: query,
      regionCode: region,
      languageCode: region === "SE" ? "sv" : "en",
      pageSize: 20,
      ...(pageToken ? { pageToken } : {}),
    }),
  });
  const json = (await res.json()) as {
    places?: { displayName?: { text?: string } }[];
    nextPageToken?: string;
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(`Places ${res.status}: ${json.error?.message || res.statusText}`);
  return {
    names: (json.places ?? []).map((p) => p.displayName?.text).filter((n): n is string => Boolean(n)),
    nextPageToken: json.nextPageToken,
  };
}

let calls = 0;

async function searchAll(query: string, region: Region): Promise<{ names: string[]; complete: boolean }> {
  const names: string[] = [];
  let token: string | undefined;
  let pages = 0;
  let complete = true;
  do {
    let page: Page | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await sleep(attempt === 0 ? 150 : 2000);
        calls++;
        page = await searchPage(query, region, token);
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt === 2 || !/429|500|503|UNAVAILABLE|page token/i.test(msg)) throw err;
      }
    }
    if (!page) throw new Error(`Places: no response for ${query}`);
    pages++;
    names.push(...page.names);
    token = page.nextPageToken;
    if (token && pages >= 3) {
      complete = false;
      break;
    }
  } while (token);
  // Nobody came back: the query did not bind to a market. That is not "they are absent".
  if (names.length === 0) complete = false;
  return { names, complete };
}

async function main() {
  ensureMapsSchema();
  const where = countryArg ? " AND country=?" : "";
  const leads = getDb()
    .prepare(`SELECT id, company, city, country, industry FROM leads WHERE status='queued' AND phone_e164 IS NOT NULL${where}`)
    .all(...(countryArg ? [countryArg] : [])) as LeadRow[];

  const packs = new Map<string, Need>();
  let tradeLeads = 0;
  for (const lead of leads) {
    const region = regionOf(lead.country);
    const trades = tradesOf(lead.industry);
    const city = lead.city?.trim() ?? "";
    if (!trades.length || region === "OTHER" || !city) continue;
    tradeLeads++;
    for (const trade of trades) {
      const key = packKey(trade, city, region);
      const query = packQuery(trade, city, region);
      if (!key || !query || packs.has(key)) continue;
      packs.set(key, { key, trade, city: cleanCity(city), region, query });
    }
  }

  const missingPacks = [...packs.values()].filter((p) => !readPack(p.key, REFRESH));
  console.log(
    `${leads.length} queued with a phone · ${tradeLeads} local-trade leads in Sweden/Australia · ${packs.size} city searches · ${missingPacks.length} not cached`
  );
  if (DRY) {
    console.log(`Upper bound if every lead also needs a name search: ${missingPacks.length + tradeLeads} Places calls.`);
    return;
  }
  if (!config.googlePlacesKey) {
    console.error("Set GOOGLE_PLACES_API_KEY. Places API (New) has to be enabled on that Google project.");
    process.exit(1);
  }

  const wanted = PROBE ? probeNeeds([...packs.values()]) : [...packs.values()];
  const toFetch = wanted.filter((p) => !readPack(p.key, REFRESH));
  if (toFetch.length > MAX) {
    console.error(`Need ${toFetch.length} city searches, over --max-calls ${MAX}. Narrow with --country or raise the cap.`);
    process.exit(1);
  }
  let errors = 0;
  for (const need of wanted) {
    if (calls >= MAX) {
      console.error(`Stopped at --max-calls ${MAX}. Re-run to continue; finished cities stay cached.`);
      break;
    }
    if (readPack(need.key, REFRESH)) continue;
    try {
      const found = await searchAll(need.query, need.region);
      const pack: Pack = { trade: need.trade, query: need.query, complete: found.complete, names: found.names };
      writePack(need.key, need.city, need.region, pack);
      console.log(`  ${need.query}: ${found.names.length} firms${found.complete ? "" : ", list cut off"}`);
      if (PROBE) console.log(`    ${found.names.slice(0, 12).join(" | ") || "(nobody)"}`);
    } catch (err) {
      errors++;
      console.error(`  FAILED ${need.query}: ${err instanceof Error ? err.message : err}`);
    }
  }

  const scope = PROBE ? probeLeads(leads, wanted) : leads;
  const tally: Record<string, number> = {};
  let stamped = 0;
  for (const lead of scope) {
    const decision = await decideLead(lead);
    if (!decision) {
      errors++;
      continue;
    }
    tally[decision.fit] = (tally[decision.fit] ?? 0) + 1;
    if (PROBE) {
      console.log(`  ${decision.fit.padEnd(10)} ${lead.company} · ${lead.city ?? "?"} · ${decision.reason}`);
      continue;
    }
    stampLead(lead.id, decision);
    stamped++;
  }

  console.log(`Calls made: ${calls}. Errors: ${errors}.`);
  console.log(Object.entries(tally).map(([k, n]) => `${k} ${n}`).join(" · ") || "nothing to decide");
  if (PROBE) {
    console.log("Probe only — nothing stamped, gate unchanged.");
    return;
  }
  console.log(`Stamped ${stamped} leads.`);
  const suitable = tally.suitable ?? 0;
  if (APPLY && errors === 0 && suitable > 0) {
    setMapsOnly(true);
    console.log(`Gate on. The cockpit now dials ${suitable} suitable leads, plus callbacks.`);
  } else if (APPLY) {
    console.error("Gate left unchanged. Need zero errors and at least one suitable lead.");
    process.exit(1);
  } else {
    console.log("Stamped, gate unchanged. Re-run with --apply to make the cockpit hide the rest.");
  }
}

type Need = { key: string; trade: string; city: string; region: Region; query: string };

/** Small Dalarna-style towns first, then Stockholm, so a probe shows both rules. */
function probeNeeds(all: Need[]): Need[] {
  const elec = all.filter((p) => p.trade === "electrician" && p.region === "SE");
  const want = ["falun", "borlange", "mora", "ranea", "ludvika", "avesta"];
  const preferred = want.map((name) => elec.find((p) => fold(p.city) === name)).filter((p): p is Need => Boolean(p));
  const small = preferred.length ? preferred.slice(0, 3) : elec.filter((p) => !isBigCity(p.city)).slice(0, 3);
  const stockholm = elec.find((p) => fold(p.city) === "stockholm");
  const picked = stockholm ? [...small, stockholm] : small;
  console.log(`Probe cities: ${picked.map((p) => p.city).join(", ") || "(none)"}`);
  return picked;
}

/** Up to four leads per probed city, and only leads whose every trade was actually searched. */
function probeLeads(leads: LeadRow[], wanted: Need[]): LeadRow[] {
  const out: LeadRow[] = [];
  for (const w of wanted) {
    const inCity = leads.filter((l) => {
      const trades = tradesOf(l.industry);
      const region = regionOf(l.country);
      if (fold(cleanCity(l.city ?? "")) !== fold(w.city) || region !== w.region) return false;
      return trades.length > 0 && trades.every((t) => wanted.some((n) => n.trade === t && n.region === region && fold(n.city) === fold(w.city)));
    });
    out.push(...inCity.slice(0, 4));
  }
  return out;
}

async function decideLead(lead: LeadRow) {
  const region = regionOf(lead.country);
  const trades = tradesOf(lead.industry);
  const city = lead.city?.trim() ?? "";
  const packs: Pack[] = [];
  for (const trade of trades) {
    const key = region === "OTHER" || !city ? null : packKey(trade, city, region);
    const stored = key ? readPack(key, false) : null;
    if (key && !stored) return null; // city search failed; leave the previous stamp alone
    if (stored) packs.push(stored);
  }

  // Shown or ambiguous is settled by the city pack. The name search is for everyone else
  // we might clear, because "no Business Profile" is its own proof and also the sort key.
  const preview = decideFit({ company: lead.company, city: lead.city, region, trades, packs, gbp: null });
  let gbp: Gbp | null = preview.fit === "shown" || preview.fit === "ambiguous" || preview.fit === "not_trade" || preview.fit === "no_city" || preview.fit === "pending"
    ? preview.gbp
    : null;
  if (gbp === null && city && region !== "OTHER" && trades.length) {
    const looked = await lookupGbp(lead.company, city, region);
    if (!looked) return null;
    gbp = looked;
  }
  return decideFit({ company: lead.company, city: lead.city, region, trades, packs, gbp });
}

async function lookupGbp(company: string, city: string, region: Region): Promise<Gbp | null> {
  const key = gbpKey(company, city, region);
  const cached = readGbp(key, REFRESH);
  if (cached) return cached.status;
  if (calls >= MAX) return "unknown";
  const query = `${company} ${cleanCity(city)}`;
  try {
    await sleep(150);
    calls++;
    const page = await searchPage(query, region);
    const judged = matchPack(company, city, page.names);
    const status: Gbp = judged.match === "same" ? "present" : judged.match === "ambiguous" ? "unknown" : "none";
    writeGbp(key, status, judged.place);
    return status;
  } catch (err) {
    console.error(`  FAILED profile ${query}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
