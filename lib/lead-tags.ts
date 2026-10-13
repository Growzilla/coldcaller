/**
 * The GHL tag scheme for prospect lists — `key:value`, lowercase, the same keys in every country so
 * a smart list built for Sweden works unchanged for AU / CA / … (only the values differ):
 *
 *   country:se  lang:sv  region:norrbotten  city:kalix          where (plan trips by region/city)
 *   niche:electrician  niche:painting                            what (English, cross-country)
 *   years:30-plus  owner-led:yes  form:company|sole-trader|partnership
 *   site:none|weak|dead|parked   gbp:present|none                online presence (site = verified only)
 *   priority:a..d  prospect:good  review:good|maybe|bad  rv:<label>
 *   contact:from-email|from-company-name|unknown                 how sure we are of the person's name
 *   src:leads-engine  list:north|painters                        provenance
 *   nix-required                                                  Swedish sole trader: NIX wash before dialing
 *
 * (revenue / employees: not in our data yet — Bolagsverket annual reports aren't parsed; never guess them)
 */

/** Leads-engine trade code → English niche (same vocabulary for every country's list). */
export const NICHE_EN: Record<string, string> = {
  bygg: "builder", snickeri: "carpentry", mark: "groundworks", el: "electrician", el_installator: "electrician",
  vvs: "plumbing", maleri: "painting", golv: "flooring", ventilation: "hvac", fasad: "facade", tak: "roofing",
  sten: "stonework", isolering: "insulation", kyl: "refrigeration", brand: "fire-protection", glas: "glazing",
  hiss: "elevators",
};

/** Swedish county (län) from the postcode — postcode areas follow the counties closely, not exactly. */
export function swedishRegion(postcode: string | null | undefined): string | null {
  const pc = String(postcode ?? "").replace(/\D/g, "");
  if (pc.length !== 5) return null;
  const p2 = Number(pc.slice(0, 2));
  const p3 = Number(pc.slice(0, 3));
  const over: Record<number, string> = {
    434: "halland", 439: "halland", // Kungsbacka / Onsala
    572: "kalmar", 577: "kalmar", 579: "kalmar", 593: "kalmar", 598: "kalmar", // Oskarshamn, Hultsfred, Högsby, Västervik, Vimmerby
    611: "södermanland", 612: "södermanland", 613: "södermanland", 619: "södermanland", // Nyköping, Oxelösund, Trosa
    662: "västra götaland", 666: "västra götaland", 668: "västra götaland", // Åmål, Bengtsfors, Dals-Ed
    294: "blekinge", // Sölvesborg
  };
  if (over[p3]) return over[p3];
  const ranges: [number, number, string][] = [
    [10, 19, "stockholm"], [20, 29, "skåne"], [30, 31, "halland"], [33, 33, "jönköping"], [34, 36, "kronoberg"],
    [37, 37, "blekinge"], [38, 39, "kalmar"], [40, 54, "västra götaland"], [55, 57, "jönköping"], [58, 61, "östergötland"],
    [62, 62, "gotland"], [63, 64, "södermanland"], [65, 68, "värmland"], [69, 71, "örebro"], [72, 73, "västmanland"],
    [74, 75, "uppsala"], [76, 76, "stockholm"], [77, 79, "dalarna"], [80, 82, "gävleborg"], [83, 84, "jämtland"],
    [85, 89, "västernorrland"], [90, 93, "västerbotten"], [94, 98, "norrbotten"],
  ];
  return ranges.find(([a, b]) => p2 >= a && p2 <= b)?.[2] ?? null;
}

export function yearsBucket(y: number | null | undefined): string | null {
  if (y == null) return null;
  return y >= 30 ? "30-plus" : y >= 20 ? "20-29" : y >= 10 ? "10-19" : y >= 5 ? "5-9" : "0-4";
}

export function tagValue(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "-").replace(/[,]/g, "");
}

// ── contact person ───────────────────────────────────────────────────────

const FIRST_NAMES = new Set(
  ("adam agneta albin alexander alf alice allan alva anders andreas anette ann anna anne annika ante anton arne arvid " +
    "axel bengt benny bernt bertil birgitta bjarne björn bo bror camilla carina carl carola caroline cecilia charlotte " +
    "christer christian christina christoffer claes conny dan daniel david dennis ebba edvard elias elin elisabeth elsa " +
    "emil emelie emma erik erika eva evert felix filip fredrik gabriel gert gunilla gunnar gustav göran hampus hanna " +
    "hannes hans harald harry helen helena henrik hugo håkan ida inga inge ingemar inger ingrid ingvar isak jakob jan " +
    "jenny jens jesper jessica jimmy joakim joel johan johanna johannes johnny jonas jonathan jonny josef julia jörgen " +
    "kai kalle karin karl katarina kenneth kent kerstin kim kjell klas krister kristian kristina kristoffer lars lena " +
    "lennart leif lina linda linnea linus lisa louise ludvig magnus malin marcus margareta maria marie marika markus " +
    "martin mathias mats mattias max michael mikael mikaela mona monica morgan nils niklas nina oliver olle olof oscar " +
    "oskar ove patrik per peter petra pontus rasmus richard rickard robert robin roger roland rolf ronny rune sandra " +
    "sara sebastian simon sofia sonja stefan sten stig susanne sven svante sylvia thomas tina tobias tom tomas tommy " +
    "tony torbjörn tore torsten ulf ulla ulrika urban valter vera viktor viktoria vilhelm william yngve åke åsa örjan " +
    "hans-olov per-olof lars-erik jan-erik karl-erik claes-göran bengt-åke").split(/\s+/)
);
const NOT_A_SURNAME = /^(bygg|el|vvs|måleri|maleri|golv|snickeri|entreprenad|mark|maskin|ab|aktiebolag|hb|kb|handelsbolag|firma|och|i|&|service|montage|teknik|consulting|konsult)$/i;

const cap = (s: string) => s.toLowerCase().replace(/(^|[-\s])\p{L}/gu, (m) => m.toUpperCase());

export type Contact = { first: string; last: string; source: "from-email" | "from-company-name" };

/**
 * The person behind the firm, only when it's clear: a "firstname[.lastname]@" company email, or a
 * company named after its owner ("Roland Axelsson Bygg AB", "Traktorfirma Anders Segerlund").
 * Founders/board aren't in the free registry — this is the best honest signal we have.
 */
export function contactPerson(company: string, email: string | null | undefined): Contact | null {
  const local = (email ?? "").toLowerCase().replace(/^%20/, "").split("@")[0] ?? "";
  const parts = local.split(/[._]/).filter(Boolean);
  if (parts.length && FIRST_NAMES.has(parts[0])) {
    const last = parts[1] && /^\p{L}{3,}$/u.test(parts[1]) && !FIRST_NAMES.has(parts[1]) ? cap(parts[1]) : "";
    // surname missing from the email? take it from a company named after the owner ("Jan Larson Maskin")
    const fromName = contactFromCompany(company);
    const sameFirst = fromName && fromName.first.toLowerCase() === parts[0];
    return { first: cap(parts[0]), last: last || (sameFirst ? fromName!.last : ""), source: "from-email" };
  }
  return contactFromCompany(company);
}

function contactFromCompany(company: string): Contact | null {
  const toks = company.replace(/[,.()]/g, " ").split(/\s+/).filter(Boolean);
  for (let i = 0; i < toks.length - 1; i++) {
    const a = toks[i].toLowerCase();
    const b = toks[i + 1];
    if (FIRST_NAMES.has(a) && /^\p{Lu}[\p{L}'-]{2,}$/u.test(b) && !NOT_A_SURNAME.test(b) && !FIRST_NAMES.has(b.toLowerCase())) {
      return { first: cap(toks[i]), last: cap(b), source: "from-company-name" };
    }
  }
  return null;
}
