#!/usr/bin/env node
/**
 * 46elks inbound SMS smoke test.
 * Run: node scripts/elks-sms-smoke-test.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function loadEnv(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch {}
  return out;
}

const env = { ...loadEnv("/home/god0fm0ney/dev/.env"), ...loadEnv(path.join(ROOT, ".env.local")) };
const user = env["46ELKS_API_USERNAME"];
const pass = env["46ELKS_API_PASSWORD"];
const numberId = env["46ELKS_NUMBER_ID"] || "n55db66883374c1cb192f4e2dfa1ded0a";
const number = env["46ELKS_NUMBER"] || "+46766861525";
const base = process.env.DIALER_TEST_URL || "http://localhost:3100";
const auth = Buffer.from(`${user}:${pass}`).toString("base64");

let passed = 0;
let failed = 0;
function ok(n) {
  passed++;
  console.log(`✓ ${n}`);
}
function fail(n, d) {
  failed++;
  console.error(`✗ ${n}: ${d}`);
}

// T1 number has sms_url configured
{
  const r = await fetch(`https://api.46elks.com/a1/numbers/${numberId}`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!r.ok) fail("number config", `HTTP ${r.status}`);
  else {
    const d = await r.json();
    if (d.sms_url && String(d.sms_url).includes("/api/elks/sms")) ok(`sms_url set → ${d.sms_url}`);
    else fail("sms_url set", `missing or wrong: ${d.sms_url ?? "null"}`);
    if (d.capabilities?.includes?.("sms") || String(d.capabilities).includes("sms"))
      ok(`number ${d.number} has SMS`);
    else fail("SMS capability", JSON.stringify(d.capabilities));
  }
}

// T2 inbox API
try {
  const r = await fetch(`${base}/api/elks/sms/inbox`);
  if (!r.ok) fail("inbox API", `HTTP ${r.status}`);
  else {
    const d = await r.json();
    if (d.number === number) ok("inbox API");
    else fail("inbox API", JSON.stringify(d));
  }
} catch (e) {
  fail("inbox API", `server down? ${e?.message || e}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(`\nManual: text ${number} from your phone — message should appear in cockpit SMS inbox within ~5s`);
process.exit(failed > 0 ? 1 : 0);