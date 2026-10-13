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
import { setElksWebhookBase } from "../lib/provider";
import { configureNumberSmsUrl, configureNumberVoiceStart, signWebhookUrl } from "../lib/elks";

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

async function syncWebhookBaseToServer(publicUrl: string) {
  try {
    const res = await fetch(`${LOCAL}/api/elks/webhook-base`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base: publicUrl }),
    });
    if (res.ok) console.log(`✓ Server webhook base → ${publicUrl}`);
    else console.log(`⊘ Server webhook base sync skipped (HTTP ${res.status})`);
  } catch {
    console.log("⊘ Server webhook base sync skipped (dev server down?)");
  }
}

async function updateElksWebhooks(publicUrl: string) {
  setElksWebhookBase(publicUrl);
  await syncWebhookBaseToServer(publicUrl);
  if (!config.elksApiUsername || !config.elksNumberId) {
    console.log("⊘ 46elks number webhooks skipped (no API creds or number id)");
    return;
  }
  // Signed with the webhook token — the routes 403 unsigned requests. Logs omit the token.
  await configureNumberVoiceStart(config.elksNumberId, signWebhookUrl(`${publicUrl}/api/elks/voice`));
  console.log(`✓ 46elks voice_start → ${publicUrl}/api/elks/voice`);
  await configureNumberSmsUrl(config.elksNumberId, signWebhookUrl(`${publicUrl}/api/elks/sms`));
  console.log(`✓ 46elks sms_url → ${publicUrl}/api/elks/sms`);
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
    Promise.allSettled([updateVonageWebhooks(m[1]), updateElksWebhooks(m[1])]).then((results) => {
      const errors = results
        .map((r, i) => (r.status === "rejected" ? `${i === 0 ? "Vonage" : "46elks"}: ${r.reason?.message || r.reason}` : null))
        .filter(Boolean);
      if (errors.length === results.length) {
        console.error(`✗ All webhook updates failed:\n  ${errors.join("\n  ")}`);
        process.exit(1);
      }
      for (const e of errors) console.warn(`⚠ ${e}`);
    });
  }
};
child.stdout.on("data", scan);
child.stderr.on("data", scan);
child.on("exit", (code) => {
  console.log(`cloudflared exited (${code})`);
  process.exit(code ?? 0);
});
