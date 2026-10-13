/**
 * One-shot: point 46elks sms_url at a public base.
 *
 * For OTP capture, prefer self-hosted on demand:
 *   sms-listen    # starts dev + tunnel, auto-registers sms_url
 *
 * Manual override (stable host only):
 *   npx tsx scripts/setup-elks-sms.ts --base https://your-host.example
 */
import { config } from "../lib/config";
import { configureNumberSmsUrl, getNumber, signWebhookUrl } from "../lib/elks";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const base = (arg("--base") || process.env.ELKS_WEBHOOK_BASE || "").replace(/\/$/, "");
  if (!base.startsWith("https://")) {
    console.error("Usage: npx tsx scripts/setup-elks-sms.ts --base https://your-host.example");
    process.exit(1);
  }
  if (!config.elksApiUsername || !config.elksNumberId) {
    console.error("Missing 46ELKS_API_USERNAME or 46ELKS_NUMBER_ID");
    process.exit(1);
  }

  const smsUrl = `${base}/api/elks/sms`;
  await configureNumberSmsUrl(config.elksNumberId, signWebhookUrl(smsUrl));
  const num = await getNumber(config.elksNumberId);
  console.log(`✓ sms_url → ${smsUrl}`);
  console.log(`  number: ${num?.number ?? config.elksNumber}`);
  console.log(`  sms_replies: no (OTP capture only)`);
}

main().catch((e) => {
  console.error(`✗ ${e?.message || e}`);
  process.exit(1);
});