/**
 * Standard follow-up texts for the cockpit: the SMS pitch (💬 / T) and the quick email (✉ / E).
 * Defaults live here; edits made in the cockpit's ✎ Templates panel are kept in localStorage.
 *
 * Placeholders: {first} {company} {city} {website} {hook} {booking} {me}
 *   {hook} = one line built from the lead's site check note ("weak site …: no mobile viewport, …")
 *
 * AU Spam Act / SE marknadsföringslagen: every commercial SMS/email names the sender and offers an
 * opt-out — keep that line when editing.
 */
import type { Lead } from "./db";

export type Lang = "en" | "sv";
/** The lead fields templates read (the cockpit's own Lead type has these, not the full DB row). */
export type TemplateLead = Pick<Lead, "company" | "first_name" | "city" | "website" | "country" | "phone_e164" | "prior_notes">;
export type Templates = { sms: string; emailSubject: string; emailBody: string };

export const DEFAULT_TEMPLATES: Record<Lang, Templates> = {
  en: {
    sms:
      "Hi {first}, Albert from Anvil Systems here, I just tried calling {company}. We build websites for trades that turn Google searches into quote requests. {hook} Worth a quick 10-min chat? {booking} Reply STOP to opt out",
    emailSubject: "Quick one about {company}'s website",
    emailBody:
      "Hi {first},\n\nI just tried giving you a call. I'm Albert from Anvil Systems: we build websites for trades that turn Google searches into quote requests.\n\n{hook}\n\nWould a quick 10-minute chat this week suit? Grab a time that works for you here: {booking}\n\nCheers,\nAlbert\nAnvil Systems · anvilsystems.io\n\nIf you'd rather not hear from me, just reply \"unsubscribe\".",
  },
  sv: {
    sms:
      "Hej {first}! Albert på Anvil Systems här, jag sökte {company} nyss. Vi bygger hemsidor åt hantverkare som ger fler offertförfrågningar via Google. {hook} Hinner du ett kort samtal på 10 min? {booking} Svara STOPP för att avregistrera",
    emailSubject: "Kort fråga om {company}s hemsida",
    emailBody:
      "Hej {first},\n\nJag försökte nå dig på telefon nyss. Jag heter Albert och jobbar på Anvil Systems: vi bygger hemsidor åt hantverkare som gör Google-sökningar till offertförfrågningar.\n\n{hook}\n\nHar du tio minuter för ett kort samtal i veckan? Boka en tid som passar här: {booking}\n\nVänliga hälsningar,\nAlbert\nAnvil Systems · anvilsystems.io\n\nVill du inte få fler mejl från mig räcker det att svara \"avregistrera\".",
  },
};

export function templateLang(lead: Pick<Lead, "country" | "phone_e164">): Lang {
  return lead.country === "Sweden" || lead.phone_e164?.startsWith("+46") ? "sv" : "en";
}

/** Mobiles that can take an SMS: SE 070/072/073/076/079 (077 = service numbers), AU 04xx, NA (can't tell mobile from landline — let it through). */
const MOBILE = /^\+(467[02369]\d{7}|614\d{8}|1\d{10})$/;

/** Where a text can go: the lead's own number when it's a mobile, else a mobile written in its notes. */
export function smsTarget(lead: Pick<Lead, "phone_e164" | "prior_notes">): string | null {
  if (lead.phone_e164 && MOBILE.test(lead.phone_e164)) return lead.phone_e164;
  for (const m of (lead.prior_notes ?? "").matchAll(/\+(?:467[02369]\d{7}|614\d{8})/g)) return m[0];
  return null;
}

/** Hook line from the AU/SE site check note: "‖ weak site https://x.com.au/: no mobile viewport, copyright 2012 (phone on page)". */
function hookLine(lead: Pick<Lead, "prior_notes" | "website" | "company">, lang: Lang): string {
  const note = lead.prior_notes ?? "";
  const weak = note.match(/weak site (\S+): ([^(\n]+)/);
  const reasons = weak?.[2]
    .split(",")
    .map((r) => r.trim())
    .filter((r) => /viewport|copyright|https|markup|click-to-call|quote form/.test(r))
    .slice(0, 2)
    .map((r) => (lang === "sv" ? SV_REASON(r) : EN_REASON(r)));
  if (reasons?.length)
    return lang === "sv"
      ? `Jag kikade på er hemsida och såg några enkla förbättringar (${reasons.join(", ")}).`
      : `I had a quick look at your website and spotted a couple of easy wins (${reasons.join(", ")}).`;
  if (/no website found|placeholder|is down|site:none/.test(note) || !lead.website)
    return lang === "sv"
      ? `Jag hittade ingen hemsida för ${lead.company}, så ni missar troligen jobb från folk som söker på Google.`
      : `I couldn't find a working website for ${lead.company}, so you're likely missing jobs from people searching on Google.`;
  return lang === "sv"
    ? "Jag kikade på er närvaro online och tror att det finns snabba vinster att hämta."
    : "I had a look at how you show up online and I think there are some quick wins there.";
}

const EN_REASON = (r: string) =>
  /viewport/.test(r) ? "it isn't built for phones" : /copyright (\d{4})/.test(r) ? `it looks like it was last updated around ${r.match(/\d{4}/)![0]}` : /https/.test(r) ? "it shows as 'not secure'" : /markup/.test(r) ? "it's built on older tech" : /click-to-call/.test(r) ? "there's no tap-to-call" : "there's no quote form";
const SV_REASON = (r: string) =>
  /viewport/.test(r) ? "den är inte anpassad för mobilen" : /copyright (\d{4})/.test(r) ? `den verkar senast uppdaterad runt ${r.match(/\d{4}/)![0]}` : /https/.test(r) ? "den visas som 'inte säker'" : /markup/.test(r) ? "den bygger på äldre teknik" : /click-to-call/.test(r) ? "det går inte att ringa med ett tryck" : "det saknas offertformulär";

export function fillTemplate(text: string, lead: TemplateLead, opts: { booking: string; me?: string }): string {
  const lang = templateLang(lead);
  const first = lead.first_name?.trim() || (lang === "sv" ? "" : "there");
  return text
    .replace(/\{first\}/g, first)
    .replace(/\{company\}/g, lead.company)
    .replace(/\{city\}/g, (lead.city ?? "").split(",")[0].trim())
    .replace(/\{website\}/g, lead.website ?? "")
    .replace(/\{hook\}/g, hookLine(lead, lang))
    .replace(/\{booking\}/g, opts.booking)
    .replace(/\{me\}/g, opts.me ?? "Albert")
    .replace(/s's\b/g, "s'") // "Elite Plumbing Services's" → "Services'"
    .replace(/Hej !/g, "Hej!")
    .replace(/Hej ,/g, "Hej,")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
