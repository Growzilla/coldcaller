/**
 * SOLID-STATE TEST SUITE — 10 tests proving the RapidDial audio path end to end.
 * All 10 must pass for greenlight. No human phones ring; legs are self-dials to our own LVN.
 *
 *   node scripts/solid-state-test.mjs
 *
 *  T1  server-state     cockpit API up, sane payload
 *  T2  webhook-public   Vonage app's registered answer_url is reachable from the internet
 *  T3  rtc-token        /api/rtc/token returns a valid JWT for our application
 *  T4  session-room     rtc session start pre-creates the room on the REGION host (409 probe)
 *  T5  answer-browser   browser leg → conversation NCCO + session live + leg_a_uuid set
 *  T6  answer-inbound   prospect calling our LVN → lead matched + call row + SSE inbound event
 *  T7  answer-selfleg   self-LVN leg joins room WITHOUT touching leg_a_uuid / creating call rows
 *  T8  e2e-hear         headless cockpit auto audio-check hears the TTS leg (🔊✅ chip)
 *  T9  e2e-send         outbound-rtp bytesSent grows — mic audio genuinely flowing out
 *  T10 intel-chain      recording upload → OpenRouter transcript + analysis land in DB
 */
import puppeteer from "puppeteer-core";
import { tokenGenerate } from "@vonage/jwt";
import Database from "better-sqlite3";
import fs from "fs";

const BASE = "http://localhost:3100";
const CHROME = "/usr/bin/google-chrome";
const DB_PATH = "data/dialer.db";
const KEY = fs.readFileSync("secrets/private.key", "utf8");
const REGION_HOST = "https://api-us-3.vonage.com";

function envVal(k) {
  for (const f of [".env.local", "/home/god0fm0ney/dev/.env"]) {
    try {
      const l = fs.readFileSync(f, "utf8").split("\n").find((x) => x.startsWith(k + "="));
      if (l) return l.slice(k.length + 1).trim().replace(/^["']|["']$/g, "");
    } catch {}
  }
  return process.env[k];
}
const APP_ID = envVal("VONAGE_APPLICATION_ID");
const API_KEY = envVal("VONAGE_REAL_KEY") || envVal("VONAGE_API_KEY");
const API_SECRET = envVal("VONAGE_API_SECRET");
const LVN = (envVal("VONAGE_NUMBER") || "+46790952801").replace(/^\+/, "");
const appJwt = () => tokenGenerate(APP_ID, KEY, {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const db = () => new Database(DB_PATH);

const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, pass: true, detail: detail || "ok", ms: Date.now() - t0 });
    console.log(`  ✅ ${name} — ${detail || "ok"} (${Date.now() - t0}ms)`);
  } catch (e) {
    results.push({ name, pass: false, detail: String(e?.message || e), ms: Date.now() - t0 });
    console.log(`  ❌ ${name} — ${e?.message || e} (${Date.now() - t0}ms)`);
  }
}

async function api(path, opts) {
  const r = await fetch(BASE + path, opts);
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

/** Collect SSE events from /api/events/stream while running fn(). */
async function withSse(fn, windowMs = 4000) {
  const events = [];
  const ctrl = new AbortController();
  const conn = fetch(BASE + "/api/events/stream", { signal: ctrl.signal }).then(async (r) => {
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (const chunk of buf.split("\n\n")) {
        const m = chunk.match(/^data: (.*)$/m);
        if (m) try { events.push(JSON.parse(m[1])); } catch {}
      }
      buf = buf.slice(buf.lastIndexOf("\n\n") + 2);
    }
  }).catch(() => {});
  await sleep(300); // let the stream attach
  await fn();
  await sleep(windowMs);
  ctrl.abort();
  await conn;
  return events;
}

async function main() {
  console.log("SOLID-STATE SUITE — RapidDial audio path\n");

  // ---------- T1 server-state ----------
  await test("T1 server-state", async () => {
    const { status, body } = await api("/api/state");
    if (status !== 200) throw new Error(`state HTTP ${status}`);
    if (typeof body.balance !== "number") throw new Error("balance missing");
    if (!body.callerId) throw new Error("callerId missing");
    return `balance €${body.balance.toFixed(2)}, queue ${body.counts?.queued}`;
  });

  // ---------- T2 webhook-public ----------
  await test("T2 webhook-public", async () => {
    const r = await fetch(`https://api.nexmo.com/v2/applications/${APP_ID}`, {
      headers: { Authorization: "Basic " + Buffer.from(`${API_KEY}:${API_SECRET}`).toString("base64") },
    });
    if (r.status !== 200) throw new Error(`applications API ${r.status}`);
    const app = await r.json();
    const answerUrl = app?.capabilities?.voice?.webhooks?.answer_url?.address;
    if (!answerUrl) throw new Error("no answer_url registered");
    const probe = await fetch(answerUrl, { method: "GET" });
    if (probe.status !== 200) throw new Error(`answer_url ${answerUrl} → HTTP ${probe.status}`);
    const ncco = await probe.json();
    if (!Array.isArray(ncco) || !ncco[0]?.action) throw new Error("answer_url returned non-NCCO");
    return answerUrl.replace(/^https:\/\//, "").split("/")[0];
  });

  // ---------- T3 rtc-token ----------
  await test("T3 rtc-token", async () => {
    const { status, body } = await api("/api/rtc/token");
    if (status !== 200 || !body.token) throw new Error(`token HTTP ${status}: ${body.error || "no token"}`);
    const payload = JSON.parse(Buffer.from(body.token.split(".")[1], "base64url").toString());
    if (payload.application_id !== APP_ID) throw new Error("token for wrong application");
    if (!payload.sub) throw new Error("token has no sub (user)");
    if (payload.exp * 1000 < Date.now()) throw new Error("token already expired");
    return `sub=${payload.sub}, exp in ${Math.round(payload.exp - Date.now() / 1000)}s`;
  });

  // ---------- T4 session-room (no browser) ----------
  await api("/api/session/end", { method: "POST" }); // clean slate
  await sleep(500);
  let sessionId = null;
  await test("T4 session-room", async () => {
    const start = await api("/api/session/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "rtc" }),
    });
    if (start.status !== 200) throw new Error(`session/start ${start.status}: ${start.body.error}`);
    sessionId = start.body.id ?? db().prepare("SELECT id FROM sessions ORDER BY id DESC LIMIT 1").get().id;
    // 409-probe: room must ALREADY exist on the region host (the two-rooms race fix)
    const probe = await fetch(`${REGION_HOST}/v1/conversations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${appJwt()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: `dialer-room-${sessionId}`, display_name: "probe" }),
    });
    if (probe.status === 409) return `dialer-room-${sessionId} pre-created on region host`;
    if (probe.status === 200 || probe.status === 201) {
      const j = await probe.json().catch(() => ({}));
      if (j.id) await fetch(`${REGION_HOST}/v1/conversations/${j.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${appJwt()}` } }).catch(() => {});
      throw new Error("room did NOT pre-exist (two-rooms race is back)");
    }
    throw new Error(`conversation probe HTTP ${probe.status}`);
  });

  // ---------- T5 answer-browser ----------
  await test("T5 answer-browser", async () => {
    const r = await api("/api/vonage/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uuid: "t5-browser-leg" }), // no from/to → browser-leg path
    });
    const ncco = r.body;
    if (ncco?.[0]?.action !== "conversation") throw new Error(`expected conversation NCCO, got ${JSON.stringify(ncco).slice(0, 120)}`);
    if (ncco[0].name !== `dialer-room-${sessionId}`) throw new Error(`wrong room: ${ncco[0].name}`);
    const s = db().prepare("SELECT status, leg_a_uuid FROM sessions WHERE id=?").get(sessionId);
    if (s.status !== "live") throw new Error(`session not live (${s.status})`);
    if (s.leg_a_uuid !== "t5-browser-leg") throw new Error(`leg_a_uuid not set (${s.leg_a_uuid})`);
    return "joined room, session live, leg_a_uuid set";
  });

  // ---------- T6 answer-inbound (Gustav's number → lead 732) ----------
  await test("T6 answer-inbound", async () => {
    const events = await withSse(async () => {
      const r = await api("/api/vonage/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: "46703401654", to: LVN, uuid: "t6-inbound-leg" }),
      });
      if (r.body?.[0]?.action !== "conversation") throw new Error(`inbound should join live room, got ${JSON.stringify(r.body).slice(0, 120)}`);
    }, 2500);
    const inbound = events.find((e) => e.type === "inbound");
    if (!inbound) throw new Error("no SSE inbound event");
    if (inbound.payload?.lead?.id !== 732) throw new Error(`lead not matched (got ${inbound.payload?.lead?.id})`);
    if (!inbound.payload?.stats) throw new Error("no stats on inbound event");
    const row = db().prepare("SELECT id, lead_id FROM calls WHERE vonage_uuid='t6-inbound-leg'").get();
    if (!row || row.lead_id !== 732) throw new Error("inbound call row missing/unlinked");
    return `lead 732 matched, ${inbound.payload.stats.calls} prior calls on event`;
  });

  // ---------- T7 answer-selfleg ----------
  await test("T7 answer-selfleg", async () => {
    const before = db().prepare("SELECT COUNT(*) n FROM calls").get().n;
    const r = await api("/api/vonage/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: LVN, to: LVN, uuid: "t7-self-leg" }),
    });
    if (r.body?.[0]?.action !== "conversation") throw new Error(`self leg should join room, got ${JSON.stringify(r.body).slice(0, 120)}`);
    const s = db().prepare("SELECT leg_a_uuid FROM sessions WHERE id=?").get(sessionId);
    if (s.leg_a_uuid !== "t5-browser-leg") throw new Error(`leg_a_uuid hijacked → ${s.leg_a_uuid}`);
    const after = db().prepare("SELECT COUNT(*) n FROM calls").get().n;
    if (after !== before) throw new Error("self leg created a call row (treated as inbound)");
    return "joined room, leg_a_uuid untouched, no junk rows";
  });

  // cleanup synthetic session + rows before E2E
  await api("/api/session/end", { method: "POST" });
  db().prepare("DELETE FROM calls WHERE vonage_uuid LIKE 't6-%'").run();
  await sleep(1000);

  // ---------- T8 + T9: real browser E2E ----------
  let browser = null;
  let chipText = null;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: "new",
      args: [
        "--no-sandbox",
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
    const ctx = browser.defaultBrowserContext();
    await ctx.overridePermissions(BASE, ["microphone"]);
    const page = await browser.newPage();
    await page.goto(BASE, { waitUntil: "networkidle2" });
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => /Start line \(browser\)/i.test(x.textContent || ""));
      if (!b) throw new Error("Start line button not found");
      b.click();
    });

    await test("T8 e2e-hear", async () => {
      // the cockpit runs its own auto audio-check after the line goes live; observe the chip
      for (let i = 0; i < 90; i++) {
        await sleep(1000);
        chipText = await page.evaluate(() => {
          const el = [...document.querySelectorAll("span")].find((s) => /🔊(✅|❌) 🎤(✅|❌)/.test(s.textContent || ""));
          return el ? el.textContent : null;
        });
        if (chipText) break;
      }
      if (!chipText) {
        const diag = await page.evaluate(() => ({
          pc: window.__rtcPcCount || 0,
          trk: window.__rtcTrackCount || 0,
          conn: window.__rtcConnState || "?",
        }));
        throw new Error(`audio-check chip never settled (pc:${diag.pc} trk:${diag.trk} conn:${diag.conn})`);
      }
      if (!chipText.includes("🔊✅")) throw new Error(`browser did NOT hear the check leg: ${chipText}`);
      await page.screenshot({ path: "/tmp/cockpit-solid-state.png" });
      return `chip: ${chipText}`;
    });

    await test("T9 e2e-send", async () => {
      const sample = () =>
        page.evaluate(async () => {
          let bytes = 0;
          for (const pc of window.__rtcPcs || []) {
            if (pc.connectionState !== "connected") continue;
            const stats = await pc.getStats();
            stats.forEach((s) => {
              if (s.type === "outbound-rtp" && (s.kind === "audio" || s.mediaType === "audio")) bytes += s.bytesSent || 0;
            });
          }
          return bytes;
        });
      const a = await sample();
      await sleep(4000);
      const b = await sample();
      if (b - a < 3000) throw new Error(`bytesSent flat (${a} → ${b}) — mic not flowing`);
      return `mic streaming: +${Math.round((b - a) / 1024)}kB over 4s (chip: ${chipText})`;
    });
  } catch (e) {
    if (!results.find((r) => r.name.startsWith("T8"))) results.push({ name: "T8 e2e-hear", pass: false, detail: String(e?.message || e), ms: 0 });
    if (!results.find((r) => r.name.startsWith("T9"))) results.push({ name: "T9 e2e-send", pass: false, detail: "skipped (browser failed)", ms: 0 });
    console.log(`  ❌ E2E browser block: ${e?.message || e}`);
  } finally {
    await api("/api/session/end", { method: "POST" }).catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }

  // ---------- T10 intel-chain ----------
  await test("T10 intel-chain", async () => {
    const fixture = "data/recordings/call-258.webm";
    if (!fs.existsSync(fixture)) throw new Error("fixture recording missing");
    const d = db();
    const callId = d
      .prepare("INSERT INTO calls (lead_id, vonage_uuid, vonage_status, ended_at) VALUES (3894, 't10-intel', 'completed', datetime('now'))")
      .run().lastInsertRowid;
    try {
      const up = await fetch(`${BASE}/api/calls/${callId}/audio`, { method: "POST", body: fs.readFileSync(fixture) });
      if (up.status !== 200) throw new Error(`upload HTTP ${up.status}`);
      for (let i = 0; i < 60; i++) {
        await sleep(2000);
        const row = db().prepare("SELECT transcript, analysis FROM calls WHERE id=?").get(callId);
        if (row?.analysis) {
          const a = JSON.parse(row.analysis);
          if (a.error) throw new Error(`analysis error: ${a.error.slice(0, 120)}`);
          if (!row.transcript || row.transcript.length < 50) throw new Error("transcript too short");
          if (!a.summary) throw new Error("analysis has no summary");
          return `transcript ${row.transcript.length} chars, interest ${a.interest}/5`;
        }
      }
      throw new Error("transcript/analysis never landed (120s)");
    } finally {
      const d2 = db();
      const rec = d2.prepare("SELECT recording_path FROM calls WHERE id=?").get(callId)?.recording_path;
      d2.prepare("DELETE FROM calls WHERE id=?").run(callId);
      if (rec && rec.includes(`call-${callId}`) && fs.existsSync(rec)) fs.unlinkSync(rec);
    }
  });

  // ---------- verdict ----------
  const passed = results.filter((r) => r.pass).length;
  console.log("\n══════════════ SOLID-STATE RESULT ══════════════");
  for (const r of results) console.log(` ${r.pass ? "✅" : "❌"} ${r.name.padEnd(18)} ${r.detail}`);
  console.log(`\n ${passed}/10 passed ${passed === 10 ? "— 🟢 GREENLIGHT" : "— 🔴 NOT SOLID"}`);
  process.exit(passed === 10 ? 0 : 1);
}

main();
