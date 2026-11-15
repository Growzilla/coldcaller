import { sendSms, signWebhookUrl } from "../elks";
import { getDb } from "../db";
import {
  claimNextSend,
  enrollCampaign,
  getSettings,
  markSendFailed,
  markSent,
  maybeCompleteCampaigns,
} from "./store";

type Sender = (opts: { to: string; message: string; whendelivered?: string }) => Promise<{ id: string }>;

export type TickResult = { action: "sent" | "failed" | "wait" | "idle"; detail: string };

function recoverStuck(now: Date) {
  const cutoff = new Date(now.getTime() - 3 * 60 * 1000).toISOString();
  getDb()
    .prepare(
      `UPDATE sms_recipients SET status='failed', error='send interrupted'
       WHERE status='sending'
         AND COALESCE((SELECT last_send_at FROM sms_send_lock WHERE id=1), '') < ?`
    )
    .run(cutoff);
}

function deliveryHook(): string | undefined {
  const base = getSettings().publicUrl;
  if (!base || /localhost|127\.0\.0\.1/i.test(base)) return undefined;
  return signWebhookUrl(`${base.replace(/\/$/, "")}/api/elks/sms/delivered`);
}

/** Send at most one campaign SMS. Safe to call on a timer. */
export async function runSmsTick(now = new Date(), sender?: Sender): Promise<TickResult> {
  recoverStuck(now);
  const running = getDb().prepare("SELECT id FROM sms_campaigns WHERE status='running'").all() as { id: number }[];
  for (const row of running) enrollCampaign(row.id);

  const claimed = claimNextSend(now);
  if (!claimed) {
    maybeCompleteCampaigns();
    return { action: "idle", detail: "Nothing ready to send." };
  }
  if ("wait" in claimed) return { action: "wait", detail: claimed.wait };

  const send = sender ?? ((opts) => sendSms(opts));
  try {
    const sent = await send({ to: claimed.phone, message: claimed.body, whendelivered: deliveryHook() });
    if (!sent?.id) throw new Error("Provider returned no message id.");
    markSent(claimed, sent.id);
    maybeCompleteCampaigns();
    return { action: "sent", detail: `${claimed.phone} ${sent.id}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : "send failed";
    markSendFailed(claimed, message);
    return { action: "failed", detail: `${claimed.phone} ${message}` };
  }
}
