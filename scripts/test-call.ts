/**
 * M1 — Pipes proof. Real bridged call through the production code path.
 *
 *   npm run test-call                    # rings your mobile, speaks a test message
 *   npm run test-call -- +46XXXXXXXXX    # rings your mobile, then bridges that number in
 *
 * Uses the same startSession/dialLead engine as the cockpit.
 */
import { config, assertCallReady } from "../lib/config";
import { getDb, activeSession, activeCall } from "../lib/db";
import { startSession, endSession, dialLead } from "../lib/vonage";

const target = process.argv[2];

async function waitFor(pred: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 1000));
    process.stdout.write(`\r  waiting: ${label} (${Math.round((Date.now() - t0) / 1000)}s) `);
  }
  console.log();
  return false;
}

async function main() {
  const notReady = assertCallReady();
  if (notReady) {
    console.error(`✗ ${notReady}`);
    process.exit(1);
  }
  console.log(`Caller ID: ${config.vonageNumber} → ringing your mobile ${config.operatorPhone} ...`);
  await startSession();

  const live = await waitFor(() => activeSession()?.status === "live", 45000, "answer your phone");
  console.log();
  if (!live) {
    console.error("✗ Leg A was not answered within 45s.");
    await endSession();
    process.exit(1);
  }
  console.log("✓ Leg A live — you should hear 'Dialer connected.'");

  if (target) {
    console.log(`Dialing second leg: ${target} ...`);
    const db = getDb();
    db.prepare(
      "INSERT OR IGNORE INTO leads (company, phone_e164, priority, status) VALUES ('TEST CALL', ?, 9, 'skipped')"
    ).run(target);
    const lead = db.prepare("SELECT id FROM leads WHERE company='TEST CALL' AND phone_e164=?").get(target) as { id: number };
    await dialLead(lead.id);
    const bridged = await waitFor(() => activeCall()?.vonage_status === "answered", 45000, "second leg to answer");
    console.log();
    console.log(bridged ? "✓ BRIDGED — both legs in the room. Talk!" : "✗ Second leg did not answer.");
    console.log("Hanging up in 20s (or Ctrl+C to end now)...");
    await new Promise((r) => setTimeout(r, 20000));
  } else {
    console.log("No second number given — staying on for 15s so you can confirm audio, then hanging up.");
    await new Promise((r) => setTimeout(r, 15000));
  }

  await endSession();
  console.log("✓ Session ended. Pipes are good.");
  process.exit(0);
}

main().catch(async (e) => {
  console.error(`✗ ${e?.message || e}`);
  await endSession().catch(() => {});
  process.exit(1);
});
