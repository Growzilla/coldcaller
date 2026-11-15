/**
 * Site truth + quality for a lead batch before it goes into the dialer (VPS el-v2 / AU batches).
 *
 *   npx tsx scripts/vps-site-check.ts in.jsonl out.jsonl
 *
 * Per row: candidates = listed website + company email domain. lib/site-verify decides whose site it is.
 * AU pages never hit the Swedish TRADE words, so an `other-business` page on the domain of their own
 * company email also counts as theirs. For a trusted site we grade quality from the homepage HTML:
 *   modern = mobile viewport + https + (recent © or a modern builder) + a way to convert (form / tel: link)
 *   weak   = anything older or thinner — the buying signal (see feedback memory: bad site = good prospect)
 * Adds: site_status (none|verified|likely|dead|parked|not-theirs), site_url, site_quality (modern|weak|null), site_why.
 */
import fs from "fs";
import { checkSite, emailDomain, hostOf, type SiteCheck } from "../lib/site-verify";

const [inp, outp] = process.argv.slice(2);
const rows = fs.readFileSync(inp, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const BUILDER = /wix\.com|squarespace|webflow|shopify|framer|duda|godaddy website builder|elementor|divi/i;

async function quality(url: string): Promise<{ q: "modern" | "weak"; why: string }> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: ctl.signal });
    clearTimeout(t);
    const html = (await res.text()).slice(0, 600000);
    const https = res.url.startsWith("https://");
    const viewport = /<meta[^>]+name=["']viewport/i.test(html);
    const years = [...html.matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(20\d{2})/gi)].map((m) => Number(m[1]));
    const year = years.length ? Math.max(...years) : null;
    const builder = BUILDER.test(html);
    const convert = /<form/i.test(html) || /href=["']tel:/i.test(html);
    const recent = (year !== null && year >= 2023) || builder;
    const gaps = [!viewport && "no mobile viewport", !https && "no https", year !== null && year < 2023 && `© ${year}`, !convert && "no form / click-to-call"].filter(Boolean) as string[];
    if (viewport && https && recent && convert) return { q: "modern", why: builder ? "modern builder site" : `modern site (© ${year})` };
    return { q: "weak", why: gaps.length ? gaps.join(", ") : "dated site" };
  } catch {
    return { q: "weak", why: "slow / failed to load" };
  }
}

async function one(r: any) {
  const who = { company: r.company, phones: [r.phone_e164, ...(r.alt_phones ?? [])].filter(Boolean), org: r.org_number ?? null, city: (r.city ?? "").split(",")[0], postcode: r.postcode ?? null };
  const ed = emailDomain(r.email);
  const cands = [...new Set([r.website, ed && `https://${ed}`].filter(Boolean) as string[])];
  if (!cands.length) return { ...r, site_status: "none", site_url: null, site_quality: null, site_why: "no website, no company email domain" };
  const checks: (SiteCheck & { own?: boolean })[] = [];
  for (const u of cands) {
    const c = await checkSite(u, who as any);
    const own = c.status === "verified" || c.status === "likely" || (c.status === "other-business" && !!ed && hostOf(c.finalUrl ?? c.url) === ed);
    checks.push({ ...c, own });
    if (own) break;
  }
  const mine = checks.find((c) => c.own);
  if (mine) {
    const url = mine.finalUrl ?? mine.url;
    const q = await quality(url);
    return { ...r, site_status: mine.status === "likely" ? "likely" : "verified", site_url: url, site_quality: q.q, site_why: q.why };
  }
  const dead = checks.every((c) => c.status === "dead" || c.status === "parked");
  return { ...r, site_status: dead ? checks[0].status : "not-theirs", site_url: null, site_quality: null, site_why: checks.map((c) => `${hostOf(c.url)}: ${c.status}`).join(" | ") };
}

(async () => {
  const out: any[] = new Array(rows.length);
  let i = 0;
  const worker = async () => {
    while (i < rows.length) {
      const k = i++;
      out[k] = await one(rows[k]).catch((e) => ({ ...rows[k], site_status: "error", site_why: String(e).slice(0, 120) }));
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  fs.writeFileSync(outp, out.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const tally: Record<string, number> = {};
  for (const r of out) tally[`${r.site_status}/${r.site_quality ?? "-"}`] = (tally[`${r.site_status}/${r.site_quality ?? "-"}`] ?? 0) + 1;
  console.log(`checked ${out.length}: ${JSON.stringify(tally)}`);
})();
