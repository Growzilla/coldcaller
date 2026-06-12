/**
 * WebRTC audio test harness for the RapidDial browser line.
 * Drives the REAL call path in headless Chrome (fake mic = real audio energy),
 * injects TTS into the browser leg, and reads RTCPeerConnection.getStats() to prove
 * audio actually flows both directions. 10 green-light tests; exits non-zero if any fail.
 *
 *   node scripts/audio-harness.mjs
 */
import puppeteer from "puppeteer-core";
import { tokenGenerate } from "@vonage/jwt";
import Database from "better-sqlite3";
import fs from "fs";

const BASE = "http://localhost:3100";
const CHROME = "/usr/bin/google-chrome";
const DB_PATH = "data/dialer.db";
const KEY = fs.readFileSync("secrets/private.key", "utf8");

function envVal(k) {
  for (const f of [".env.local", "/home/god0fm0ney/dev/.env"]) {
    try {
      const line = fs.readFileSync(f, "utf8").split("\n").find((l) => l.startsWith(k + "="));
      if (line) return line.slice(k.length + 1).trim().replace(/^["']|["']$/g, "");
    } catch {}
  }
  return process.env[k];
}
const APP_ID = envVal("VONAGE_APPLICATION_ID");
const appJwt = () => tokenGenerate(APP_ID, KEY, {});

const results = [];
const rec = (n, pass, detail) => {
  results.push({ n, pass });
  console.log(`${pass ? "✅ PASS" : "❌ FAIL"}  T${n.toString().padStart(2)} — ${detail}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function vapi(pathname, method = "GET", body) {
  const r = await fetch(`https://api.nexmo.com${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${appJwt()}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
function activeSession() {
  const db = new Database(DB_PATH, { readonly: true });
  const s = db.prepare("SELECT * FROM sessions WHERE status IN ('starting','live') ORDER BY id DESC LIMIT 1").get();
  db.close();
  return s;
}

async function main() {
  // ---------- T1: config ----------
  rec(1, !!APP_ID && KEY.includes("PRIVATE KEY"),
    `appId=${APP_ID ? APP_ID.slice(0, 8) + "…" : "MISSING"}, privateKey ${KEY.includes("PRIVATE KEY") ? "loaded" : "MISSING"}`);

  // ---------- T2: app webhook reachable ----------
  const app = await vapi(`/v2/applications/${APP_ID}`);
  const answerUrl = app.body?.capabilities?.voice?.webhooks?.answer_url?.address || "";
  let webhookOk = false;
  try {
    const wr = await fetch(answerUrl + "?probe=1", { method: "GET" });
    webhookOk = wr.status === 200;
  } catch {}
  rec(2, webhookOk, `answer_url=${answerUrl || "NONE"} reachable=${webhookOk}`);

  // ---------- T3: token ----------
  const tok = await fetch(BASE + "/api/rtc/token").then((r) => r.json()).catch((e) => ({ error: String(e) }));
  rec(3, !!tok.token, tok.token ? `JWT len ${tok.token.length}` : `error: ${tok.error}`);

  // ---------- T4: ensureOperatorUser idempotent (hit token route twice) ----------
  const t4a = await fetch(BASE + "/api/rtc/token").then((r) => r.status);
  const t4b = await fetch(BASE + "/api/rtc/token").then((r) => r.status);
  rec(4, t4a === 200 && t4b === 200, `repeat token calls → ${t4a}, ${t4b}`);

  // clean any stale session before driving the browser
  await fetch(BASE + "/api/session/end", { method: "POST" }).catch(() => {});
  await sleep(1500);

  // ---------- launch headless chrome with fake mic ----------
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: [
      "--no-sandbox",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  let liveOk = false, leg = null;
  try {
    const ctx = browser.defaultBrowserContext();
    await ctx.overridePermissions(BASE, ["microphone"]);
    const page = await browser.newPage();
    page.on("console", (m) => { if (/error|fail|denied/i.test(m.text())) console.log("   [browser]", m.text().slice(0, 160)); });
    // capture every RTCPeerConnection the SDK creates, BEFORE page scripts run
    await page.evaluateOnNewDocument(() => {
      window.__pcs = [];
      const O = window.RTCPeerConnection;
      function Patched(...a) { const pc = new O(...a); window.__pcs.push(pc); return pc; }
      Patched.prototype = O.prototype;
      window.RTCPeerConnection = Patched;
      window.webkitRTCPeerConnection = Patched;
    });
    await page.goto(BASE, { waitUntil: "networkidle2" });

    // ---------- T5: SDK loads + createSession (click the browser Start line button) ----------
    const clicked = await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => /Start line/i.test(x.textContent || ""));
      if (b) { b.click(); return true; }
      return false;
    });
    await sleep(1500);
    const errBanner = await page.evaluate(() =>
      [...document.querySelectorAll("div")].map((d) => d.textContent || "").find((t) => /Browser line failed|Could not get/i.test(t)) || ""
    );
    rec(5, clicked && !errBanner, clicked ? (errBanner ? `error: ${errBanner.slice(0, 120)}` : "Start line clicked, SDK session opening") : "Start line button not found");

    // ---------- T6: session goes live + leg_a_uuid ----------
    for (let i = 0; i < 30; i++) {
      const s = activeSession();
      if (s && s.status === "live" && s.leg_a_uuid) { liveOk = true; leg = s.leg_a_uuid; break; }
      await sleep(1000);
    }
    rec(6, liveOk, liveOk ? `session live, leg_a=${leg.slice(0, 8)}…` : "session never reached live");

    // ---------- T7: ICE connected ----------
    const readStats = () => page.evaluate(async () => {
      const out = [];
      for (const pc of window.__pcs || []) {
        const o = { ice: pc.iceConnectionState, sent: 0, recv: 0, hasRemote: false };
        try {
          const s = await pc.getStats();
          s.forEach((r) => {
            if (r.type === "outbound-rtp" && r.kind === "audio") o.sent += r.packetsSent || 0;
            if (r.type === "inbound-rtp" && r.kind === "audio") o.recv += r.packetsReceived || 0;
          });
        } catch {}
        out.push(o);
      }
      const audioEls = [...document.querySelectorAll("audio")].filter((e) => {
        const ms = e.srcObject; return ms && ms.getAudioTracks && ms.getAudioTracks().length;
      });
      return { pcs: out, remoteAudioEls: audioEls.length, totalAudio: document.querySelectorAll("audio").length };
    });
    await sleep(2000);
    let st = await readStats();
    const iceConnected = st.pcs.some((p) => p.ice === "connected" || p.ice === "completed");
    rec(7, iceConnected, `pc states: ${st.pcs.map((p) => p.ice).join(",") || "no PC"}`);

    // ---------- T8: outbound media (packetsSent grows) ----------
    const sent1 = Math.max(0, ...st.pcs.map((p) => p.sent));
    await sleep(3000);
    st = await readStats();
    const sent2 = Math.max(0, ...st.pcs.map((p) => p.sent));
    rec(8, sent2 > sent1 && sent2 > 5, `outbound audio packetsSent ${sent1} → ${sent2}`);

    // ---------- T9: inbound media (inject TTS to browser leg, packetsReceived grows) ----------
    let recvOk = false, recv1 = Math.max(0, ...st.pcs.map((p) => p.recv)), recv2 = recv1, talkStatus = "skipped";
    if (liveOk && leg) {
      const talkBody = { text: "Audio test one two three four five six seven eight nine ten", loop: 3 };
      for (const host of ["https://api-us-3.vonage.com", "https://api.nexmo.com", "https://api-eu-3.vonage.com"]) {
        const r = await fetch(`${host}/v1/calls/${leg}/talk`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${appJwt()}`, "Content-Type": "application/json" },
          body: JSON.stringify(talkBody),
        });
        talkStatus = `${host.split("//")[1].split(".")[0]}:${r.status}`;
        if (r.status === 200) break;
      }
      for (let i = 0; i < 8; i++) {
        await sleep(1500);
        st = await readStats();
        recv2 = Math.max(0, ...st.pcs.map((p) => p.recv));
        if (recv2 > recv1 + 10) { recvOk = true; break; }
      }
    }
    rec(9, recvOk, `talk PUT=${talkStatus}; inbound packetsReceived ${recv1} → ${recv2}, remoteAudioEls=${st.remoteAudioEls}`);

    // ---------- T10: DOM playback element + repeatable restart ----------
    const domOk = st.totalAudio > 0;
    await fetch(BASE + "/api/session/end", { method: "POST" }).catch(() => {});
    await sleep(2000);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => /Start line/i.test(x.textContent || ""));
      b && b.click();
    });
    let live2 = false;
    for (let i = 0; i < 25; i++) { const s = activeSession(); if (s && s.status === "live") { live2 = true; break; } await sleep(1000); }
    rec(10, domOk && live2, `remote <audio> in DOM=${domOk}; second start→live=${live2}`);
  } catch (e) {
    console.log("HARNESS ERROR:", e?.message || e);
  } finally {
    await fetch(BASE + "/api/session/end", { method: "POST" }).catch(() => {});
    await browser.close();
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n================  ${passed}/10 GREEN  ================`);
  process.exit(passed === 10 ? 0 : 1);
}
main();
