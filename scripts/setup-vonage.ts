/**
 * M0 — One-time Vonage setup. Idempotent; run until everything is ✓.
 *
 *   npm run setup
 *
 * 1. Verifies API key + secret against the balance endpoint
 * 2. Creates (or finds) the "coldcaller" Voice application → saves secrets/private.key
 * 3. Confirms ownership of the caller-ID number and links it to the application
 * 4. Appends VONAGE_APPLICATION_ID to .env.local
 */
import fs from "fs";
import path from "path";
import { config } from "../lib/config";

const APP_NAME = "coldcaller";
const ENV_LOCAL = path.join(process.cwd(), ".env.local");
const KEY_PATH = path.join(process.cwd(), "secrets", "private.key");

const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const fail = (msg: string) => {
  console.error(`  ✗ ${msg}`);
  process.exit(1);
};

async function main() {
  console.log("1. Credentials");
  if (!config.vonageApiKey || !config.vonageApiSecret)
    fail(
      "Need BOTH VONAGE_API_KEY (8 chars) and VONAGE_API_SECRET in /home/god0fm0ney/dev/.env or .env.local.\n" +
        "    Get them at dashboard.vonage.com → API settings."
    );
  const balRes = await fetch(
    `https://rest.nexmo.com/account/get-balance?api_key=${config.vonageApiKey}&api_secret=${encodeURIComponent(config.vonageApiSecret)}`
  );
  if (!balRes.ok)
    fail(`Balance check failed (HTTP ${balRes.status}) — key/secret pair is wrong. Check dashboard.vonage.com.`);
  const balance = (await balRes.json()) as { value: number };
  ok(`Credentials valid — balance €${Number(balance.value).toFixed(2)}`);
  if (Number(balance.value) < 1) console.log("  ⚠ Balance under €1 — top up before a calling session.");

  // Lazy-import the SDK only after creds are proven (its Auth requires them).
  const { Vonage } = await import("@vonage/server-sdk");
  const { Auth } = await import("@vonage/auth");
  const basic = new Vonage(new Auth({ apiKey: config.vonageApiKey, apiSecret: config.vonageApiSecret }));

  console.log("2. Voice application");
  let appId = config.applicationId;
  let havePrivateKey = fs.existsSync(KEY_PATH) || (config.privateKeyPath !== KEY_PATH && fs.existsSync(config.privateKeyPath));
  if (appId && havePrivateKey) {
    ok(`Using existing application ${appId}`);
  } else {
    const apps = await basic.applications.listApplications({});
    const existing = (apps as any)._embedded?.applications?.find((a: any) => a.name === APP_NAME);
    if (existing && havePrivateKey) {
      appId = existing.id;
      ok(`Found existing application ${appId}`);
    } else {
      if (existing)
        console.log(`  ⚠ App "${APP_NAME}" exists but private key is missing locally — creating a fresh app.`);
      // Placeholder webhooks: outbound calls use inline NCCOs + REST polling, so these never fire.
      const created = await basic.applications.createApplication({
        name: existing ? `${APP_NAME}-2` : APP_NAME,
        capabilities: {
          voice: {
            webhooks: {
              answerUrl: { address: "https://example.com/answer", httpMethod: "GET" },
              eventUrl: { address: "https://example.com/event", httpMethod: "POST" },
            },
          },
        },
      } as any);
      appId = (created as any).id;
      const privateKey = (created as any).keys?.privateKey ?? (created as any).keys?.private_key;
      if (!privateKey) fail("Application created but no private key returned — delete it in the dashboard and re-run.");
      fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true });
      fs.writeFileSync(KEY_PATH, privateKey, { mode: 0o600 });
      ok(`Created application ${appId}, private key → secrets/private.key`);
    }
  }

  console.log("3. Caller-ID number");
  const owned = await basic.numbers.getOwnedNumbers({});
  const numbers: any[] = (owned as any).numbers ?? [];
  const wanted = config.vonageNumber.replace(/^\+/, "");
  const lvn = numbers.find((n) => n.msisdn === wanted);
  if (!lvn) {
    console.log(`  Owned numbers: ${numbers.map((n) => "+" + n.msisdn).join(", ") || "(none)"}`);
    fail(`${config.vonageNumber} is NOT on this Vonage account — buy/verify it in the dashboard, or fix VONAGE_NUMBER.`);
  }
  ok(`${config.vonageNumber} is owned (${lvn.country}, ${lvn.type})`);
  if (lvn.app_id !== appId) {
    await basic.numbers.updateNumber({
      msisdn: lvn.msisdn,
      country: lvn.country,
      applicationId: appId,
    } as any);
    ok(`Linked ${config.vonageNumber} → application (inbound calls will hit the app)`);
  } else {
    ok("Number already linked to the application");
  }

  console.log("4. Local config");
  let envText = fs.existsSync(ENV_LOCAL) ? fs.readFileSync(ENV_LOCAL, "utf8") : "";
  const ensure = (key: string, value: string) => {
    if (new RegExp(`^${key}=`, "m").test(envText)) return;
    envText += `${envText.endsWith("\n") || envText === "" ? "" : "\n"}${key}=${value}\n`;
    ok(`Wrote ${key} to .env.local`);
  };
  ensure("VONAGE_APPLICATION_ID", appId);
  ensure("VONAGE_NUMBER", config.vonageNumber);
  if (!config.operatorPhone) {
    envText += `# Your mobile (leg A), E.164:\n# OPERATOR_PHONE=+467XXXXXXXX\n`;
    console.log("  ⚠ Set OPERATOR_PHONE in .env.local (your own mobile, E.164) — required before calling.");
  }
  fs.writeFileSync(ENV_LOCAL, envText);

  console.log("\nSetup complete. Next: npm run test-call");
}

main().catch((e) => fail(e?.message || String(e)));
