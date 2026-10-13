/**
 * Pull verdicts out of the dialer wrapups (callback = good, bad number + note = bad), re-rank
 * every prospect and reorder the local dial queue. Local only — GHL gets it via /review → Sync.
 *
 *   npm run review:rank
 */
import { applyRanking, flagWrongSiteVerdicts, importCallFeedback } from "../lib/review";

const calls = importCallFeedback();
console.log(`dialer feedback: ${calls.good} good, ${calls.bad} bad, ${calls.kept} kept from /review`);
const recheck = flagWrongSiteVerdicts();
if (recheck) console.log(`${recheck} bad verdicts were given on a website that isn't theirs → back in the review queue (first in line)`);
const r = applyRanking();
const m = r.model;
console.log(`verdicts: ${m.good} good · ${m.maybe} maybe · ${m.bad} bad — learned pattern ${r.delta ? "ON" : "off (need 8 good + 8 bad)"}`);
console.log(`ranked ${r.ranked} prospects · ${r.requeuedGood} good leads to the top of the dial queue · ${r.removedBad} bad ones out`);
const fmt = (p: { feature: string; goodRate: number; n: number }) => `  ${p.feature.padEnd(30)} ${Math.round(p.goodRate * 100)}% good (n=${p.n})`;
console.log("points to good:\n" + m.patterns.filter((p) => p.lift > 0).slice(0, 8).map(fmt).join("\n"));
console.log("points to bad:\n" + m.patterns.filter((p) => p.lift < 0).slice(-8).reverse().map(fmt).join("\n"));
