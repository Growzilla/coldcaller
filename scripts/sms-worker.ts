import { runSmsTick } from "../lib/sms/tick";

const interval = Number(process.env.SMS_WORKER_INTERVAL_MS || 30_000);

console.log(`[sms-worker] one send per tick, every ${interval}ms`);

async function loop() {
  try {
    const result = await runSmsTick();
    if (result.action === "sent" || result.action === "failed") {
      console.log(`[sms-worker] ${result.action} ${result.detail}`);
    }
  } catch (err) {
    console.error("[sms-worker]", err);
  }
}

void loop();
setInterval(() => void loop(), interval);
