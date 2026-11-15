/**
 * Call when the lead's own clock is in a working block: 09:00–12:00 or 13:00–16:00.
 * Australia is several zones; a fixed offset would be wrong half the year, so this
 * resolves a zone and asks Intl. From Stockholm in winter, 07:00 is 14:00 in Perth
 * and 17:00 in Sydney — only Perth (and Darwin, until 16:00) is in the block.
 */

export type ZoneLead = {
  city?: string | null;
  country?: string | null;
  prior_notes?: string | null;
};

const AU_ZONE: Record<string, string> = {
  WA: "Australia/Perth",
  NT: "Australia/Darwin",
  SA: "Australia/Adelaide",
  QLD: "Australia/Brisbane",
  NSW: "Australia/Sydney",
  ACT: "Australia/Sydney",
  VIC: "Australia/Melbourne",
  TAS: "Australia/Hobart",
};

/** Capitals and cities whose name alone is a zone. Suburbs without a state code stay unknown. */
const BARE_CITY: Record<string, string> = {
  perth: "WA",
  fremantle: "WA",
  bunbury: "WA",
  kalgoorlie: "WA",
  geraldton: "WA",
  albany: "WA",
  broome: "WA",
  mandurah: "WA",
  darwin: "NT",
  "alice springs": "NT",
  adelaide: "SA",
  brisbane: "QLD",
  "gold coast": "QLD",
  "sunshine coast": "QLD",
  cairns: "QLD",
  townsville: "QLD",
  sydney: "NSW",
  newcastle: "NSW",
  wollongong: "NSW",
  canberra: "ACT",
  melbourne: "VIC",
  geelong: "VIC",
  hobart: "TAS",
  launceston: "TAS",
};

/**
 * Canada is not one clock. A city name is not enough (Calgary the town vs the zone).
 * Imports stamp `CA America/Toronto` at the start of prior_notes; only that token counts.
 */
const CA_ZONES = [
  "America/St_Johns",
  "America/Halifax",
  "America/Goose_Bay",
  "America/Toronto",
  "America/Winnipeg",
  "America/Regina",
  "America/Edmonton",
  "America/Yellowknife",
  "America/Dawson_Creek",
  "America/Creston",
  "America/Whitehorse",
  "America/Vancouver",
  "America/Iqaluit",
];
const CA_ZONE_SET = new Set(CA_ZONES);
const CA_NOTE = /\bCA\s+(America\/[A-Za-z_]+)/;

/** One-zone countries. The US, and Canada without a CA zone note, stay unresolved. */
const COUNTRY_ZONE: Record<string, string> = {
  sweden: "Europe/Stockholm",
  norway: "Europe/Oslo",
  denmark: "Europe/Copenhagen",
  finland: "Europe/Helsinki",
  germany: "Europe/Berlin",
  france: "Europe/Paris",
  netherlands: "Europe/Amsterdam",
  belgium: "Europe/Brussels",
  italy: "Europe/Rome",
  spain: "Europe/Madrid",
  portugal: "Europe/Lisbon",
  switzerland: "Europe/Zurich",
  austria: "Europe/Vienna",
  poland: "Europe/Warsaw",
  ireland: "Europe/Dublin",
  "united kingdom": "Europe/London",
  uk: "Europe/London",
  "new zealand": "Pacific/Auckland",
};

const AU_ZONES = ["Australia/Perth", "Australia/Darwin", "Australia/Adelaide", "Australia/Brisbane", "Australia/Sydney", "Australia/Melbourne", "Australia/Hobart"];

/** Far-west NSW keeps Adelaide time, not Sydney. */
const BROKEN_HILL = /\b(broken hill|silverton|menindee)\b/i;

/** IANA zone for a lead, or null when the place is ambiguous. */
export function leadTimeZone(lead: ZoneLead): string | null {
  const country = (lead.country ?? "").trim().toLowerCase();
  const city = (lead.city ?? "").trim();
  const notes = lead.prior_notes ?? "";
  const noted = notes.match(CA_NOTE)?.[1];
  if (noted && CA_ZONE_SET.has(noted)) return noted;
  const australia = country === "australia" || (country === "" && /^AU\b/i.test(notes));
  if (australia) {
    if (BROKEN_HILL.test(city)) return "Australia/Broken_Hill";
    const state =
      city.match(/,\s*(WA|NT|SA|QLD|NSW|ACT|VIC|TAS)\b/i)?.[1]?.toUpperCase() ||
      notes.match(/^AU\s+(WA|NT|SA|QLD|NSW|ACT|VIC|TAS)\b/i)?.[1]?.toUpperCase() ||
      BARE_CITY[city.toLowerCase()];
    return (state && AU_ZONE[state]) || null;
  }
  return COUNTRY_ZONE[country] ?? null;
}

const hourCache = new Map<string, number>();

/** Hour 0–23 in `zone`. Some ICU builds report midnight as 24. Cached per zone per minute. */
export function localHour(zone: string, now = new Date()): number {
  const key = `${zone}\0${Math.floor(now.getTime() / 60_000)}`;
  const hit = hourCache.get(key);
  if (hit !== undefined) return hit;
  const raw = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(now)
    .find((p) => p.type === "hour")?.value;
  const hour = Number(raw) === 24 ? 0 : Number(raw);
  hourCache.set(key, hour);
  return hour;
}

function clock(zone: string, now: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
}

function placeName(zone: string): string {
  return (zone.split("/").pop() ?? zone).replaceAll("_", " ");
}

/** True when local time is 09:00–12:00 or 13:00–16:00. Ends are exclusive. */
export function inCallWindow(zone: string | null | undefined, now = new Date()): boolean {
  if (!zone) return false;
  const hour = localHour(zone, now);
  return (hour >= 9 && hour < 12) || (hour >= 13 && hour < 16);
}

/** The queue gate: this lead is in a calling block right now. */
export function leadInCallWindow(lead: ZoneLead, now = new Date()): boolean {
  return inCallWindow(leadTimeZone(lead), now);
}

/** "Perth 14:05", or null when the lead has no zone. */
export function leadClock(lead: ZoneLead, now = new Date()): string | null {
  const zone = leadTimeZone(lead);
  if (!zone) return null;
  return `${placeName(zone)} ${clock(zone, now)}`;
}

function zonesForCountry(country?: string | null): string[] {
  const name = (country ?? "").trim().toLowerCase();
  if (!name) return [...AU_ZONES, ...CA_ZONES, ...Object.values(COUNTRY_ZONE)];
  if (name === "australia") return [...AU_ZONES];
  if (name === "canada") return [...CA_ZONES];
  const zone = COUNTRY_ZONE[name];
  return zone ? [zone] : [];
}

/** Zones in a calling block for this country filter. "Perth 14:05 · Darwin 15:35". */
export function openWindowLabel(country?: string | null, now = new Date()): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const zone of zonesForCountry(country)) {
    if (seen.has(zone) || !inCallWindow(zone, now)) continue;
    seen.add(zone);
    parts.push(`${placeName(zone)} ${clock(zone, now)}`);
  }
  return parts.join(" · ");
}
