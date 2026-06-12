/**
 * Self-configuring webhook tunnel (needed ONLY for browser/WebRTC calling).
 *
 *   npm run tunnel        # keep running alongside `npm run dev`
 *
 * 1. Starts a cloudflared quick tunnel → random public https URL
 * 2. Points the Vonage application's answer/event webhooks at it
 * 3. Stays in the foreground; Ctrl+C to stop
 *
 * Phone-mode calling never needs this — inline NCCOs + polling cover it.
 */
import { spawn } from "child_process";
import { config } from "../lib/config";

const LOCAL = "http://localhost:3100";

async function updateVonageWebhooks(publicUrl: string) {
  const { Vonage } = await import("@vonage/server-sdk");
  const { Auth } = await import("@vonage/auth");
  const basic = new Vonage(new Auth({ apiKey: config.vonageApiKey, apiSecret: config.vonageApiSecret }));
  const app: any = await basic.applications.getApplication(config.applicationId);
  app.capabilities = app.capabilities ?? {};
  app.capabilities.voice = {
    webhooks: {
      answerUrl: { address: `${publicUrl}/api/vonage/answer`, httpMethod: "GET" },
      eventUrl: { address: `${publicUrl}/api/vonage/event`, httpMethod: "POST" },
    },
  };
  await basic.applications.updateApplication(app);
  console.log(`✓ Vonage app webhooks → ${publicUrl}/api/vonage/{answer,event}`);
}

const child = spawn("cloudflared", ["tunnel", "--url", LOCAL], { stdio: ["ignore", "pipe", "pipe"] });
let configured = false;

const scan = (chunk: Buffer) => {
  const text = chunk.toString();
  process.stderr.write(text);
  const m = text.match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/);
  if (m && !configured) {
    configured = true;
    console.log(`\n✓ Tunnel up: ${m[1]}`);
    updateVonageWebhooks(m[1]).catch((e) => {
      console.error(`✗ Failed to update Vonage webhooks: ${e?.message || e}`);
      process.exit(1);
    });
  }
};
child.stdout.on("data", scan);
child.stderr.on("data", scan);
child.on("exit", (code) => {
  console.log(`cloudflared exited (${code})`);
  process.exit(code ?? 0);
});
