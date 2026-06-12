/**
 * Two-leg BRIDGE harness. Proves the browser leg and a server-SDK-created leg land in the
 * SAME Vonage conversation (so audio actually crosses) — the thing the earlier harness missed.
 *
 * Leg A: headless Chrome (Client SDK serverCall) → joins dialer-room-{id}.
 * Leg B: server-SDK createOutboundCall to our own LVN (auto-answered by the app's answer webhook,
 *        no human rings), NCCO conversation name=dialer-room-{id}. Created TWICE — once via the
 *        DEFAULT api host (reproduce the bug) and once via the leg-A REGION host (test the fix).
 * Checks: conversation_uuid(A) === conversation_uuid(B)?  + does the browser HEAR leg B's TTS?
 *
 *   node scripts/audio-bridge-harness.mjs
 */
import puppeteer from "puppeteer-core";
import { tokenGenerate } from "@vonage/jwt";
import Database from "better-sqlite3";
import fs from "fs";

const BASE = "http://localhost:3100";
const CHROME = "/usr/bin/google-chrome";
const DB_PATH = "data/dialer.db";
const KEY = fs.readFileSync("secrets/private.key", "utf8");
const HOSTS = { default: "https://api.nexmo.com", region: "https://api-us-3.vonage.com" };

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
const LVN = (envVal("VONAGE_NUMBER") || "+46790952801").replace(/^\+/, "");
const appJwt = () => tokenGenerate(APP_ID, KEY, {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function vget(host, path) {
  const r = await fetch(`${host}${path}`, { headers: { Authorization: `Bearer ${appJwt()}` } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function createLegB(host, convName) {
  // exact dialLead shape: outbound call, inline NCCO joins the conversation by the given reference
  const r = await fetch(`${host}/v1/calls`, {
    method: "POST",
    headers: { Authorization: `Bearer ${appJwt()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      to: [{ type: "phone", number: LVN }],
      from: { type: "phone", number: LVN },
      ncco: [{ action: "conversation", name: convName, startOnEnter: true }],
    }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function convUuidOf(uuid) {
  for (const host of Object.values(HOSTS)) {
    const c = await vget(host, `/v1/calls/${uuid}`);
    if (c.status === 200 && c.body.conversation_uuid) return c.body.conversation_uuid;
  }
  return null;
}
function activeSession() {
  const db = new Database(DB_PATH, { readonly: true });
  const s = db.prepare("SELECT * FROM sessions WHERE status IN ('starting','live') ORDER BY id DESC LIMIT 1").get();
  db.close();
  return s;
}

async function main() {
  await fetch(BASE + "/api/session/end", { method: "POST" }).catch(() => {});
  await sleep(1200);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
  const out = { sameConv_default: null, sameConv_region: null, browserHeardB: null, convA: null };
  try {
    const ctx = browser.defaultBrowserContext();
    await ctx.overridePermissions(BASE, ["microphone"]);
    const page = await browser.newPage();
    // capture remote audio RMS in the browser (does it actually HEAR the other leg?)
    await page.evaluateOnNewDocument(() => {
      window.__pcs = [];
      window.__remoteRMS = 0;
      const O = window.RTCPeerConnection;
      function P(...a) {
        const pc = new O(...a);
        window.__pcs.push(pc);
        pc.addEventListener("track", (ev) => {
          if (ev.track.kind !== "audio") return;
          try {
            const ac = new AudioContext();
            const src = ac.createMediaStreamSource(ev.streams[0] || new MediaStream([ev.track]));
            const an = ac.createAnalyser(); an.fftSize = 512; src.connect(an);
            const buf = new Uint8Array(an.frequencyBinCount);
            const tick = () => { an.getByteTimeDomainData(buf); let p = 0; for (const v of buf) p = Math.max(p, Math.abs(v - 128)); window.__remoteRMS = p; requestAnimationFrame(tick); };
            tick();
          } catch {}
        });
        return pc;
      }
      P.prototype = O.prototype; window.RTCPeerConnection = P; window.webkitRTCPeerConnection = P;
    });
    await page.goto(BASE, { waitUntil: "networkidle2" });
    await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /Start line/i.test(x.textContent || "")); b && b.click(); });

    // wait for leg A live
    let sess = null;
    for (let i = 0; i < 30; i++) { const s = activeSession(); if (s?.status === "live" && s.leg_a_uuid) { sess = s; break; } await sleep(1000); }
    if (!sess) throw new Error("leg A never went live");
    const room = `dialer-room-${sess.id}`;
    out.convA = await convUuidOf(sess.leg_a_uuid);
    console.log(`leg A: session ${sess.id}, room=${room}, conv=${out.convA}`);

    // ---- Leg B: default=join by NAME (reproduce), region=join by leg-A conversation_uuid (candidate fix) ----
    for (const [label, host] of Object.entries(HOSTS)) {
      const b = await createLegB(host, room); // join by the (now pre-created) room name
      const legB = b.body?.uuid;
      console.log(`leg B (${label}@${host}): HTTP ${b.status} uuid=${legB || JSON.stringify(b.body).slice(0,150)}`);
      let convB = null;
      if (legB) for (let i = 0; i < 8; i++) { await sleep(1500); convB = await convUuidOf(legB); if (convB) break; }
      const same = !!convB && convB === out.convA;
      console.log(`   conv=${convB} | same as leg A? ${same}`);
      if (label === "default") out.sameConv_default = same;
      if (label === "region") {
        out.sameConv_region = same;
        // audio: make leg B speak; does the browser's remote RMS rise?
        if (legB && same) {
          await page.evaluate(() => (window.__rmsBefore = window.__remoteRMS || 0));
          await fetch(`${HOSTS.region}/v1/calls/${legB}/talk`, {
            method: "PUT", headers: { Authorization: `Bearer ${appJwt()}`, "Content-Type": "application/json" },
            body: JSON.stringify({ text: "bridge audio test one two three four five", loop: 3 }),
          });
          let peak = 0;
          for (let i = 0; i < 8; i++) { await sleep(1200); const rms = await page.evaluate(() => window.__remoteRMS || 0); peak = Math.max(peak, rms); }
          out.browserHeardB = peak;
          console.log(`   browser remote RMS peak while leg B spoke: ${peak}`);
        }
      }
      if (legB) await fetch(`${HOSTS.region}/v1/calls/${legB}`, { method: "PUT", headers: { Authorization: `Bearer ${appJwt()}`, "Content-Type": "application/json" }, body: JSON.stringify({ action: "hangup" }) }).catch(() => {});
      await sleep(1500);
    }

    // ---- APP PATH: the REAL dialLead path via /api/test-call to the LVN (no human ring) ----
    const tc = await fetch(BASE + "/api/test-call", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ number: "+" + LVN }) }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
    let appConv = null;
    if (tc.callId) {
      for (let i = 0; i < 8; i++) {
        await sleep(1500);
        const db = new Database(DB_PATH, { readonly: true });
        const row = db.prepare("SELECT vonage_uuid FROM calls WHERE id=?").get(tc.callId);
        db.close();
        if (row?.vonage_uuid) { appConv = await convUuidOf(row.vonage_uuid); if (appConv) break; }
      }
    }
    out.appPathSameConv = !!appConv && appConv === out.convA;
    console.log(`APP PATH (/api/test-call → dialLead): conv=${appConv} | same as leg A? ${out.appPathSameConv} (callId=${tc.callId || tc.error})`);
  } catch (e) {
    console.log("HARNESS ERROR:", e?.message || e);
  } finally {
    await fetch(BASE + "/api/session/end", { method: "POST" }).catch(() => {});
    await browser.close();
  }

  console.log("\n================ BRIDGE RESULT ================");
  console.log(`leg A conv:                 ${out.convA}`);
  console.log(`default host → same conv?   ${out.sameConv_default}  ${out.sameConv_default === false ? "(reproduces bug ✅)" : ""}`);
  console.log(`region host  → same conv?   ${out.sameConv_region}  ${out.sameConv_region ? "(FIX WORKS ✅)" : "(region-pin NOT enough ❌)"}`);
  console.log(`browser heard leg B (RMS):  ${out.browserHeardB}  ${out.browserHeardB > 3 ? "(cross-leg audio ✅)" : ""}`);
  console.log(`APP PATH same conv?         ${out.appPathSameConv}  ${out.appPathSameConv ? "(real dialLead bridges ✅)" : "(app path NOT bridged ❌)"}`);
  const pass = out.sameConv_region === true && out.browserHeardB > 3 && out.appPathSameConv === true;
  console.log(`\n================  ${pass ? "BRIDGE FIXED ✅" : "NOT FIXED ❌"}  ================`);
  process.exit(pass ? 0 : 1);
}
main();
