/**
 * Verify that each prospect's website is really theirs (lib/site-verify.ts) and record the URL we
 * trust. Candidates: the listed website, the domain of their company email, and any URL Albert wrote
 * in a review note ("real site https://…", trusted as verified). Resumable; --force re-checks all.
 *
 *   npm run review:sites [-- --force] [-- --limit N] [-- --status likely]
 */
import { reviewDb, type Prospect } from "../lib/review";
import { checkSite, emailDomain, hostOf, type SiteCheck } from "../lib/site-verify";

const force = process.argv.includes("--force");
const limitArg = process.argv.indexOf("--limit");
const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : 0;
const db = reviewDb();

const statusArg = process.argv.indexOf("--status"); // re-check one verdict class, e.g. --status likely
const onlyStatus = statusArg > 0 ? process.argv[statusArg + 1] : null;
const where = onlyStatus ? `WHERE site_status='${onlyStatus.replace(/[^a-z-]/g, "")}'` : force ? "" : "WHERE site_checked_at IS NULL";
const rows = db
  .prepare(`SELECT * FROM prospects ${where} ORDER BY verdict IS NULL, v2 DESC${limit ? ` LIMIT ${limit}` : ""}`)
  .all() as (Prospect & { website_orig: string | null })[];

const save = db.prepare(
  "UPDATE prospects SET site_status=?, site_url=?, site_evidence=?, email_suspect=?, website_orig=COALESCE(website_orig, website), site_checked_at=datetime('now') WHERE id=?"
);
const RANK: Record<string, number> = { verified: 6, likely: 5, "other-business": 4, "name-only": 3, parked: 2, mismatch: 1, dead: 0 };
const NOTE_URL = /\b((?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9-]{1,62}\.(?:se|com|nu|net|org|eu|info|biz|io))(\/[^\s,)]*)?/gi;

function noteUrls(note: string | null): string[] {
  if (!note) return [];
  return [...note.matchAll(NOTE_URL)].map((m) => (m[1].startsWith("http") ? m[1] : `https://${m[1]}`)).filter((u) => !/hitta\.se|google\./i.test(u));
}

async function one(p: Prospect & { website_orig: string | null }) {
  const listed = p.website_orig ?? p.website;
  const who = {
    company: p.company,
    phones: [p.phone, p.alt_phone].filter(Boolean) as string[],
    org: p.org_number,
    city: p.city,
    postcode: p.postcode,
  };
  const fromNote = noteUrls(p.note);
  if (fromNote.length) {
    save.run("verified", fromNote[0], "URL given by reviewer", 0, p.id);
    return "verified";
  }
  const cands = new Set<string>();
  if (listed) cands.add(listed);
  const ed = emailDomain(p.email);
  if (ed && ed !== hostOf(listed)) cands.add(`https://${ed}`);
  if (!cands.size) {
    save.run("none", null, "no website on file", 0, p.id);
    return "none";
  }
  const checks: SiteCheck[] = [];
  for (const u of cands) {
    const c = await checkSite(u, who);
    checks.push(c);
    if (c.status === "verified") break;
  }
  checks.sort((a, b) => RANK[b.status] - RANK[a.status]);
  const best = checks[0];
  const trusted = best.status === "verified" || best.status === "likely";
  const listedCheck = checks.find((c) => c.url === listed);
  // an email on the domain of someone else's site was scraped from that site → not theirs
  const emailSuspect = ed && ["mismatch", "name-only"].includes(listedCheck?.status ?? "") && ed === hostOf(listed) ? 1 : 0;
  const evidence = checks.map((c) => `${hostOf(c.url)}: ${c.status} (${c.evidence}${c.title ? `; “${c.title.slice(0, 50)}”` : ""})`).join(" | ");
  save.run(best.status, trusted ? (best.finalUrl ?? best.url) : null, evidence.slice(0, 1000), emailSuspect, p.id);
  return best.status;
}

(async () => {
  const tally: Record<string, number> = {};
  let i = 0, done = 0;
  const started = Date.now();
  const worker = async () => {
    while (i < rows.length) {
      const p = rows[i++];
      const s = await one(p).catch(() => "error");
      tally[s] = (tally[s] ?? 0) + 1;
      if (++done % 200 === 0) console.log(`… ${done}/${rows.length} (${Math.round((Date.now() - started) / 1000)}s) ${JSON.stringify(tally)}`);
    }
  };
  await Promise.all(Array.from({ length: 24 }, worker));
  console.log(`checked ${done}: ${JSON.stringify(tally)}`);
})();
