/**
 * Load prospects for the lead review page (/review). Idempotent: re-running keeps every verdict,
 * refreshes rows from the GHL export and adds new rows from the lists.
 *
 *   npm run review:import
 *
 * Paths default to lib/review.ts DEFAULT_SOURCES; override with REVIEW_EXPORT, REVIEW_PRIORITY,
 * REVIEW_NORTH, REVIEW_PAINTER.
 */
import { DEFAULT_SOURCES, counts, importProspects, sourceCounts } from "../lib/review";

const stats = importProspects({
  exportJsonl: process.env.REVIEW_EXPORT || DEFAULT_SOURCES.exportJsonl,
  priorityCsv: process.env.REVIEW_PRIORITY || DEFAULT_SOURCES.priorityCsv,
  north: process.env.REVIEW_NORTH || DEFAULT_SOURCES.north,
  painter: process.env.REVIEW_PAINTER || DEFAULT_SOURCES.painter,
});
for (const [name, s] of Object.entries(stats)) {
  console.log(`${name.padEnd(8)} read ${s.read}, new ${s.added}, overlap merged ${s.merged}`);
}
const c = counts({});
console.log(`prospects: ${c.total} total, ${c.left} left to review`);
console.log("by source: " + sourceCounts().map((s) => `${s.source} ${s.n}`).join(", "));
