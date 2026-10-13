/**
 * One-shot: make sure the 46elks account has a WebRTC client number for the 🎧 browser line.
 *
 *   npm run elks:webrtc            # show what exists (no charge)
 *   npm run elks:webrtc -- --allocate   # allocate one if missing (46elks: 30 SEK/month)
 *
 * The browser registers to wss://voip.46elks.com as this number (SIP user = digits, password =
 * the number's `secret`); the server discovers it automatically (lib/elks-rtc.ts), so nothing
 * has to be copied into .env.local. Calls still show +46766861525 as caller ID to the lead.
 */
import { config } from "../lib/config";
import { getBalanceSek, listNumbers } from "../lib/elks";

async function main() {
  if (!config.elksApiUsername || !config.elksApiPassword) {
    console.error("Missing 46ELKS_API_USERNAME / 46ELKS_API_PASSWORD");
    process.exit(1);
  }
  const nums = await listNumbers();
  const rtc = nums.find(
    (n) => n.active === "yes" && Array.isArray(n.capabilities) && (n.capabilities as string[]).includes("webrtc")
  );
  if (rtc) {
    console.log(`✓ WebRTC number ${rtc.number} (id ${rtc.id}) — secret ${rtc.secret ? "present" : "MISSING"}`);
    return;
  }
  const sek = await getBalanceSek();
  console.log(`⊘ no WebRTC number on the account (balance ${sek?.toFixed(2) ?? "?"} SEK)`);
  if (!process.argv.includes("--allocate")) {
    console.log("  re-run with --allocate to buy one (30 SEK/month)");
    return;
  }
  const auth = "Basic " + Buffer.from(`${config.elksApiUsername}:${config.elksApiPassword}`).toString("base64");
  const res = await fetch("https://api.46elks.com/a1/numbers", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
    // Verified 2026-10-12: only capabilities=webrtc is accepted for country se ("voice,webrtc" / any
    // category → 403 "Cannot allocate webrtc numbers with support for …"). 403 "Not enough credits" = top up.
    body: new URLSearchParams({ country: "se", capabilities: "webrtc" }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`✗ allocate failed HTTP ${res.status}: ${text.slice(0, 300)}`);
    process.exit(1);
  }
  const n = JSON.parse(text);
  console.log(`✓ allocated WebRTC number ${n.number} (id ${n.id}) — the cockpit picks it up on next 🎧 Start line`);
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
