/**
 * Is this website actually the company's? The leads-engine guessed many domains from the
 * company name (claes.se for "Linde byggnads Claes Amlinger", segerlund.se = an accounting firm),
 * so a URL is only trusted when the page itself proves it:
 *
 *   verified  — their phone / org number is on the page AND it's a trade site (or the reviewer gave the URL)
 *   other-business — their phone is there but the site is the owner's OTHER business (coach, accountant,
 *               theatre…): it is not this company's website
 *   likely    — the distinctive part of the company name AND their town/postcode are on the page
 *   name-only — name matches but nothing ties it to them (same-name firm elsewhere, a brand…)
 *   mismatch  — the page loads but is someone else's
 *   parked    — for sale / placeholder / under construction
 *   dead      — no answer, DNS failure, 4xx/5xx
 *
 * Only verified/likely sites may be shown or exported as the company's website.
 */

export type SiteStatus = "verified" | "other-business" | "likely" | "name-only" | "mismatch" | "parked" | "dead";

/** Words that make a page read as a trades business. Short ones need word boundaries ("kontakt" ⊃ "tak"). */
const TRADE = /bygg|snickar|snickeri|elinstall|elektrik|elfirma|elservice|eltjänst|\bel\b|vvs|rörmok|rörarbet|måler|målning|gräv|schakt|markarbet|entrepren|\btak\b|takläg|plåt|golv|kakel|ventilation|kyl|isoler|fasad|glasmäst|maskin|rivning|demontage|anläggning|avlopp|sprut|bläst|lift|antenn|montage|hantverk|renover|murning|smide|svets|betong|dränering|brunn|trädgård|städ|fönster|borrning|sten/i;
export type SiteCheck = { status: SiteStatus; url: string; finalUrl?: string; evidence: string; title?: string };

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const GENERIC = new Set(
  ("ab aktiebolag aktiebolaget handelsbolag hb kb kommanditbolag firma firman och i & the of " +
    "bygg byggnads byggnad byggare bygger byggservice byggteknik byggen byggnadsfirma entreprenad entreprenör " +
    "el elservice elteknik elektriska elinstallation vvs rör rörläggeri måleri målning golv snickeri snickare " +
    "mark maskin maskiner schakt gräv grävning transport tak plåt fasad sten isolering kyl ventilation glas " +
    "service montage montering teknik installation installationer sverige svenska nordic group gruppen " +
    "väst öst syd norr west city stad allbygg allservice").split(/\s+/)
);

const FIRST_NAMES = new Set(
  ("adam albin alexander anders andreas anna anders ante anton arne bengt bertil birger bo bror carl christer christian " +
    "claes dan daniel david emil erik fredrik gunnar göran gustav hans harry henrik inge ingvar jan jens jesper joakim " +
    "johan johnny jonas jonny jörgen kalle karl kenneth kent kjell lars leif lennart magnus marcus martin mats mattias " +
    "michael mikael niklas nils olle olof oskar per peter patrik rasmus robert roger roland rolf rune sebastian simon " +
    "stefan sten stig sven thomas tobias tomas tommy torbjörn ulf urban viktor åke").split(/\s+/)
);

/** "Roland", "Axelsson", "Andreason" — a person's name doesn't prove a site is the FIRM's. */
function personName(t: string): boolean {
  return FIRST_NAMES.has(t) || /(ss?on|sen)$/.test(t);
}

/** Name tokens that can identify the company ("Pengfors", "Segerlund", "Kurlanders"). */
export function distinctiveTokens(company: string): string[] {
  return company
    .toLowerCase()
    .replace(/[^\p{L}\d\s-]/gu, " ")
    .split(/[\s-]+/)
    .filter((t) => t.length >= 4 && !GENERIC.has(t) && !/^\d+$/.test(t));
}

/** Expired domains re-used for casino / betting / adult spam — never the company's. */
const SPAM = /casino|betting|spelbolag|sportsbook|porn|escort|viagra|payday loan|crypto ?(casino|exchange)/i;

const PARKED = /(domänen (är )?till salu|this domain (is|may be) for sale|domain for sale|buy this domain|parkerad|parked (domain|free)|under construction|kommer snart|coming soon|website is under construction|webbhotell.{0,40}(standardsida|välkommen)|one\.com.{0,80}(welcome|välkommen)|default web page|it works!|index of \/)/i;

function textOf(html: string): { text: string; visibleText: string; title: string; links: string[]; visible: number } {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const links = [...html.matchAll(/href=["']([^"'#]+)["']/gi)].map((m) => m[1]);
  const decode = (x: string) =>
    x.replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  const visibleText = decode(
    html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")
  ).toLowerCase();
  // + attribute values (tel:/mailto: hrefs, meta descriptions) and the raw document: Wix/Squarespace
  // keep the page text in JSON inside scripts
  const attrs = [...html.matchAll(/(?:content|href|alt|title)=["']([^"']*)["']/gi)].map((m) => m[1]).join(" ");
  const text = `${visibleText} ${decode(attrs).toLowerCase()} ${decode(html).toLowerCase()}`;
  return { text, visibleText, title, links, visible: visibleText.length };
}

/** National significant number: +46 (0)70-684 41 31 / 070 684 41 31 / 0046706844131 → 706844131 */
function nsn(raw: string): string {
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("0046")) d = d.slice(4);
  else if (d.startsWith("46") && d.length >= 10) d = d.slice(2);
  return d.replace(/^0+/, "");
}

/** Phone numbers written on the page (formatted ones only — never substrings of ids or hashes). */
function phonesOn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:\+|00)\s*46[\s\-–()]*(?:\(0\))?(?:[\s\-–.\/]*\d){7,10}|(?<![\d.])0\d(?:[\s\-–.\/]*\d){6,9}(?!\d)/g)) {
    const n = nsn(m[0]);
    if (n.length >= 7 && n.length <= 10) out.add(n);
  }
  return out;
}

async function get(url: string): Promise<{ ok: boolean; status: number; html: string; finalUrl: string }> {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(9000), headers: { "User-Agent": UA, Accept: "text/html,*/*" } });
    const html = res.ok ? (await res.text()).slice(0, 600_000) : "";
    return { ok: res.ok, status: res.status, html, finalUrl: res.url || url };
  } catch {
    return { ok: false, status: 0, html: "", finalUrl: url };
  }
}

type Who = { company: string; phones: string[]; org: string | null; city: string | null; postcode: string | null };

function judge(t: ReturnType<typeof textOf>, who: Who): { status: SiteStatus; evidence: string } | null {
  const text = t.text;
  const toks = distinctiveTokens(who.company);
  const named = toks.length > 0 && toks.every((x) => text.includes(x));
  const trade = TRADE.test(t.title) || TRADE.test(t.visibleText);
  let proof: string | null = null;
  const onPage = phonesOn(text);
  for (const p of who.phones) if (onPage.has(nsn(p))) proof = `phone ${p} on page`;
  if (!proof && who.org) {
    for (const m of text.matchAll(/(?<!\d)\d{6}[-\s]?\d{4}(?!\d)/g)) if (m[0].replace(/\D/g, "") === who.org) proof = "org number on page";
  }
  if (proof) {
    // The owner's mobile also sits on their coaching / accounting / theatre site — not this firm's site.
    // It's the firm's when the page is about trade work, names the firm (beyond the owner's own name),
    // or uses the trade word in the firm's name ("maskin", "bygg").
    const firm = toks.filter((x) => !personName(x));
    const nameWords = who.company.toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length >= 3 && GENERIC.has(w) && TRADE.test(w));
    const names = firm.length > 0 && firm.every((x) => text.includes(x));
    const tradeWord = nameWords.some((w) => t.visibleText.includes(w) || t.title.toLowerCase().includes(w));
    if (trade || names || tradeWord) return { status: "verified", evidence: proof };
    return { status: "other-business", evidence: `${proof}, but the site isn't about trade work` };
  }
  if (named && TRADE.test(t.title) && toks.some((x) => t.title.toLowerCase().includes(x))) {
    return { status: "likely", evidence: `name + trade in page title` };
  }
  const city = (who.city ?? "").toLowerCase().trim();
  const pc = (who.postcode ?? "").replace(/\s/g, "");
  // "Sandvikens Måleri" in Sandviken: the name token IS the town, so name + town proves nothing
  const nameIsTown = toks.length > 0 && toks.every((x) => city && (city.includes(x.replace(/s$/, "")) || x.includes(city)));
  if (nameIsTown) return named ? { status: "name-only", evidence: `name "${toks.join(" ")}" is just their town` } : null;
  const placed = (city.length >= 3 && text.includes(city)) || (pc.length === 5 && (text.includes(pc) || text.includes(`${pc.slice(0, 3)} ${pc.slice(3)}`)));
  if (named && placed) return { status: "likely", evidence: `name "${toks.join(" ")}" + ${city || pc} on page` };
  if (named) return { status: "name-only", evidence: `name "${toks.join(" ")}" but not their town/phone` };
  return null;
}

/** Check one candidate URL: homepage, then one contact page if the homepage doesn't prove it. */
export async function checkSite(url: string, who: Who): Promise<SiteCheck> {
  const home = await get(url);
  if (!home.ok) return { status: "dead", url, evidence: home.status ? `HTTP ${home.status}` : "no answer" };
  const h = textOf(home.html);
  // a tiny page is NOT parked (a one-pager from 2009 is the ideal prospect) — only real placeholders are
  if ((h.visible < 1500 && PARKED.test(h.text.slice(0, 30000))) || PARKED.test(h.title)) {
    return { status: "parked", url, finalUrl: home.finalUrl, evidence: "placeholder / parked page", title: h.title };
  }
  let best = judge(h, who);
  // a spam page can't be theirs unless it carries their phone/org number (then it's a hacked site of theirs)
  if (best?.status !== "verified" && (SPAM.test(h.title) || SPAM.test(h.visibleText.slice(0, 5000)))) {
    return { status: "mismatch", url, finalUrl: home.finalUrl, evidence: "domain re-used for spam", title: h.title };
  }
  if (best?.status !== "verified") {
    const contact = h.links.find((l) => /kontakt|contact|om-oss|about/i.test(l));
    if (contact) {
      let cu: string | null = null;
      try {
        cu = new URL(contact, home.finalUrl).toString();
      } catch {
        cu = null;
      }
      if (cu && new URL(cu).host === new URL(home.finalUrl).host) {
        const c = await get(cu);
        if (c.ok) {
          const j = judge(textOf(c.html), who);
          const rank: Record<string, number> = { verified: 4, likely: 3, "other-business": 2, "name-only": 1 };
          if (j && (rank[j.status] ?? 0) > (rank[best?.status ?? ""] ?? 0)) best = j;
        }
      }
    }
  }
  return { ...(best ?? { status: "mismatch" as const, evidence: "page doesn't mention them" }), url, finalUrl: home.finalUrl, title: h.title };
}

const GENERIC_MAIL = /@(gmail|hotmail|outlook|live|yahoo|icloud|telia|bredband|spray|msn|me|comhem|bahnhof|tele2)\./i;

/** Domain of a company email, when it isn't a free-mail provider. */
export function emailDomain(email: string | null | undefined): string | null {
  const e = (email ?? "").trim().toLowerCase().replace(/^%20/, "");
  if (!e.includes("@") || GENERIC_MAIL.test(e)) return null;
  return e.split("@")[1] || null;
}

export function hostOf(url: string | null | undefined): string {
  return (url ?? "").replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0].toLowerCase();
}
