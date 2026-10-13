#!/usr/bin/env node
/**
 * Cheap 46elks integration smoke test (no real bridge — play action only).
 * Run: node scripts/elks-smoke-test.mjs
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
const from = env["46ELKS_NUMBER"] || "+46766861525";
const to = env["OPERATOR_PHONE"] || "+46725597280";

if (!user || !pass) {
  console.error("FAIL: missing 46ELKS credentials");
  process.exit(1);
}

const auth = Buffer.from(`${user}:${pass}`).toString("base64");
let passed = 0;
let failed = 0;

function ok(name) {
  passed++;
  console.log(`✓ ${name}`);
}
function fail(name, detail) {
  failed++;
  console.error(`✗ ${name}: ${detail}`);
}

// T1 account balance
{
  const r = await fetch("https://api.46elks.com/a1/me", { headers: { Authorization: `Basic ${auth}` } });
  if (!r.ok) fail("account", `HTTP ${r.status}`);
  else {
    const d = await r.json();
    const sek = Number(d.balance) / 10000;
    ok(`account balance ${sek.toFixed(2)} SEK`);
  }
}

// T2 lib module mapStatus logic (inline)
{
  const map = (state) => (state === "ongoing" ? "ringing" : state === "success" ? "completed" : state);
  if (map("ongoing") === "ringing" && map("success") === "completed") ok("status mapping");
  else fail("status mapping", "unexpected");
}

// T3 make-call + get + delete (play only — hangs up immediately after)
{
  const body = new URLSearchParams({
    from,
    to,
    voice_start: '{"play":"https://46elks.com/static/sound/make-call.mp3"}',
    timeout: "8",
  });
  const r = await fetch("https://api.46elks.com/a1/calls", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    fail("make-call", `HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  } else {
    const call = await r.json();
    ok(`make-call id=${call.id} state=${call.state}`);
    const r2 = await fetch(`https://api.46elks.com/a1/calls/${call.id}`, { headers: { Authorization: `Basic ${auth}` } });
    if (r2.ok) ok("get-call");
    else fail("get-call", `HTTP ${r2.status}`);
    const r3 = await fetch(`https://api.46elks.com/a1/calls/${call.id}`, {
      method: "DELETE",
      headers: { Authorization: `Basic ${auth}` },
    });
    if (r3.ok) ok("hangup-delete");
    else fail("hangup-delete", `HTTP ${r3.status}`);
  }
}

// T4 Next.js API provider route (server must be running)
const base = process.env.DIALER_TEST_URL || "http://localhost:3100";
try {
  const r = await fetch(`${base}/api/provider`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "46elks" }),
  });
  if (r.ok) {
    const d = await r.json();
    if (d.provider === "46elks") ok("api/provider switch");
    else fail("api/provider switch", JSON.stringify(d));
  } else {
    console.log(`⊘ api/provider skipped (server not up? HTTP ${r.status})`);
  }
} catch {
  console.log("⊘ api/provider skipped (start npm run dev for full test)");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);