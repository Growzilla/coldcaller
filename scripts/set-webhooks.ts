/**
 * Flip the Vonage app's voice webhooks to a given base URL — the deploy "cutover" knob.
 *
 *   npx tsx scripts/set-webhooks.ts                         # read-only: print current target
 *   npx tsx scripts/set-webhooks.ts https://rapiddial.onrender.com   # point at the 24/7 Render box
 *   npx tsx scripts/set-webhooks.ts https://xxxx.trycloudflare.com   # point back at a local tunnel
 *
 * Same updateApplication call `npm run tunnel` makes, but standalone + idempotent so you can
 * move inbound + browser-leg traffic between the Render box and a local cloudflared tunnel
 * without starting a tunnel. Reads creds from /home/god0fm0ney/dev/.env via lib/config.
 *
 * ⚠️ Operator-gated: repointing kills whichever line is currently live during the swap. Do it
 *    between call blocks. After pointing at Render, run the cockpit from the Render URL (not
 *    localhost) and confirm the line-check chip 🔊✅ 🎤✅ before trusting it.
 */
import { config } from "../lib/config";

async function main() {
  const base = process.argv[2]?.trim();
  const { Vonage } = await import("@vonage/server-sdk");
  const { Auth } = await import("@vonage/auth");
  const basic = new Vonage(new Auth({ apiKey: config.vonageApiKey, apiSecret: config.vonageApiSecret }));

  const app: any = await basic.applications.getApplication(config.applicationId);
  const cur = app?.capabilities?.voice?.webhooks ?? {};
  const addr = (w: any) => w?.address ?? "(none)";
  console.log(`app: ${app?.name} (${config.applicationId})`);
  console.log(`current answer_url: ${addr(cur.answerUrl ?? cur.answer_url)}`);
  console.log(`current event_url : ${addr(cur.eventUrl ?? cur.event_url)}`);

  if (!base) {
    console.log("\nRead-only (no URL given). Pass a base URL to repoint, e.g. https://rapiddial.onrender.com");
    return;
  }
  if (!/^https:\/\//.test(base)) {
    console.error("\n✗ Base URL must be https://… — refusing to set an insecure webhook.");
    process.exit(1);
  }
  const clean = base.replace(/\/+$/, "");

  app.capabilities = app.capabilities ?? {};
  app.capabilities.voice = {
    ...(app.capabilities.voice ?? {}),
    webhooks: {
      answerUrl: { address: `${clean}/api/vonage/answer`, httpMethod: "GET" },
      eventUrl: { address: `${clean}/api/vonage/event`, httpMethod: "POST" },
    },
  };
  await basic.applications.updateApplication(app);
  console.log(`\n✓ Vonage webhooks → ${clean}/api/vonage/{answer,event}`);
  console.log("  Verify: open the cockpit at that URL, log in, Start line, confirm 🔊✅ 🎤✅.");
}

main().catch((e) => {
  console.error("✗", e?.message || e);
  process.exit(1);
});
