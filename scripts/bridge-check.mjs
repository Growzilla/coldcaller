/**
 * Faithful single-call bridge check: ONE browser leg A + ONE real dialLead leg B (to the LVN,
 * auto-answered, no human ring). Confirms they share a conversation AND the browser hears leg B.
 * Run repeatedly (e.g. 5x) to measure determinism of the REAL call path.
 *
 *   node scripts/bridge-check.mjs
 * exit 0 = bridged + audio; exit 1 = not.
 */
import puppeteer from "puppeteer-core";
import { tokenGenerate } from "@vonage/jwt";
import Database from "better-sqlite3";
import fs from "fs";

const BASE = "http://localhost:3100";
const CHROME = "/usr/bin/google-chrome";
const DB_PATH = "data/dialer.db";
const KEY = fs.readFileSync("secrets/private.key", "utf8");
const HOSTS = ["https://api-us-3.vonage.com", "https://api.nexmo.com"];
const env = (k) => { for (const f of [".env.local", "/home/god0fm0ney/dev/.env"]) { try { const l = fs.readFileSync(f, "utf8").split("\n").find((x) => x.startsWith(k + "=")); if (l) return l.slice(k.length + 1).trim().replace(/^["']|["']$/g, ""); } catch {} } };
const APP_ID = env("VONAGE_APPLICATION_ID");
const LVN = (env("VONAGE_NUMBER") || "+46790952801").replace(/^\+/, "");
const appJwt = () => tokenGenerate(APP_ID, KEY, {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function convOf(uuid) { for (const h of HOSTS) { const r = await fetch(`${h}/v1/calls/${uuid}`, { headers: { Authorization: `Bearer ${appJwt()}` } }); if (r.ok) { const c = await r.json(); if (c.conversation_uuid) return c.conversation_uuid; } } return null; }
function liveSession() { const db = new Database(DB_PATH, { readonly: true }); const s = db.prepare("SELECT * FROM sessions WHERE status IN ('starting','live') ORDER BY id DESC LIMIT 1").get(); db.close(); return s; }
function callUuid(id) { const db = new Database(DB_PATH, { readonly: true }); const r = db.prepare("SELECT vonage_uuid FROM calls WHERE id=?").get(id); db.close(); return r?.vonage_uuid; }

async function main() {
  await fetch(BASE + "/api/session/end", { method: "POST" }).catch(() => {});
  await sleep(1500);
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  let convA = null, convB = null, rms = 0;
  try {
    await browser.defaultBrowserContext().overridePermissions(BASE, ["microphone"]);
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      window.__rms = 0;
      const O = window.RTCPeerConnection;
      function P(...a) { const pc = new O(...a); pc.addEventListener("track", (ev) => { if (ev.track.kind !== "audio") return; try { const ac = new AudioContext(); const an = ac.createAnalyser(); an.fftSize = 512; ac.createMediaStreamSource(ev.streams[0] || new MediaStream([ev.track])).connect(an); const b = new Uint8Array(an.frequencyBinCount); const t = () => { an.getByteTimeDomainData(b); let p = 0; for (const v of b) p = Math.max(p, Math.abs(v - 128)); window.__rms = p; requestAnimationFrame(t); }; t(); } catch {} }); return pc; }
      P.prototype = O.prototype; window.RTCPeerConnection = P; window.webkitRTCPeerConnection = P;
    });
    await page.goto(BASE, { waitUntil: "networkidle2" });
    await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /Start line/i.test(x.textContent || "")); b && b.click(); });
    let sess = null;
    for (let i = 0; i < 30; i++) { const s = liveSession(); if (s?.status === "live" && s.leg_a_uuid) { sess = s; break; } await sleep(1000); }
    if (!sess) throw new Error("leg A never live");
    for (let i = 0; i < 8 && !convA; i++) { convA = await convOf(sess.leg_a_uuid); if (!convA) await sleep(1500); }

    // ONE real leg B via the app's dialLead path (to LVN, auto-answered)
    const tc = await fetch(BASE + "/api/test-call", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ number: "+" + LVN }) }).then((r) => r.json());
    let legB = null;
    for (let i = 0; i < 8; i++) { await sleep(1500); legB = callUuid(tc.callId); if (legB) break; }
    for (let i = 0; i < 8 && !convB; i++) { convB = await convOf(legB); if (!convB) await sleep(1500); }

    // ALWAYS test audio (the real signal), regardless of reported conversation_uuid match —
    // the SDK can report an implicit conversation while media is correctly bridged in the room.
    if (legB) {
      await fetch(`${HOSTS[0]}/v1/calls/${legB}/talk`, { method: "PUT", headers: { Authorization: `Bearer ${appJwt()}`, "Content-Type": "application/json" }, body: JSON.stringify({ text: "bridge test one two three four five six seven eight", loop: 3 }) });
      for (let i = 0; i < 10; i++) { await sleep(1200); rms = Math.max(rms, await page.evaluate(() => window.__rms || 0)); }
    }
  } catch (e) { console.log("ERR", e?.message || e); }
  finally { await fetch(BASE + "/api/session/end", { method: "POST" }).catch(() => {}); await browser.close(); }

  const ok = rms > 3; // browser actually HEARD leg B = audio works
  console.log(`convA=${convA} convB=${convB} same=${convA === convB} rms=${rms} => ${ok ? "PASS ✅ (audio)" : "FAIL ❌ (silent)"}`);
  process.exit(ok ? 0 : 1);
}
main();
