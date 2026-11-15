import { config } from "../config";
import { sendSms } from "../elks";
import { classifyReply, notificationText } from "./logic";
import {
  getContactByPhone,
  getSettings,
  hasNotification,
  recordInbound,
  recordNotification,
} from "./store";

function threadUrl(contactId: number): string {
  const base = getSettings().publicUrl.replace(/\/$/, "");
  return `${base}/sms/inbox/${contactId}`;
}

async function alertOperator(input: { key: string; contactId: number | null; messageId: number | null; kind: "positive" | "call"; body: string }) {
  if (hasNotification(input.key)) return;
  const to = getSettings().notifyNumber;
  if (!to) {
    recordNotification({ ...input, error: "Set a notification number in SMS settings." });
    return;
  }
  if (!config.elksApiUsername || !config.elksApiPassword) {
    recordNotification({ ...input, error: "46elks credentials are missing." });
    return;
  }
  try {
    await sendSms({ to, message: input.body });
    recordNotification(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : "notification failed";
    recordNotification({ ...input, error: message });
    console.error("[sms] notification failed", message);
  }
}

/** Store an inbound SMS, classify it, suppress opt-outs, and alert on a positive reply. */
export async function ingestInboundSms(input: { id: string; from: string; message: string }) {
  const { classification, reason } = classifyReply(input.message);
  const recorded = recordInbound({
    providerId: input.id,
    phone: input.from,
    body: input.message,
    classification,
    reason,
  });
  if (recorded.created && classification === "positive" && recorded.contact) {
    const contact = recorded.contact;
    // Do not hold the 46elks webhook open while the operator SMS goes out.
    void alertOperator({
      key: `positive:${recorded.messageId}`,
      contactId: contact.id,
      messageId: recorded.messageId,
      kind: "positive",
      body: notificationText({
        kind: "positive",
        name: contact.name,
        company: contact.company,
        phone: contact.phone_e164,
        reply: input.message,
        reason,
        url: threadUrl(contact.id),
      }),
    });
  }
  return recorded;
}

/** Alert when the VOIP number is called. Never throws — the voice webhook must still answer. */
export async function notifyInboundCall(e164: string, callId: string | null) {
  try {
    const own = config.elksNumber.replace(/\D/g, "");
    if (!e164 || e164.replace(/\D/g, "") === own) return;
    const key = `call:${callId || e164}`;
    const contact = getContactByPhone(e164);
    await alertOperator({
      key,
      contactId: contact?.id ?? null,
      messageId: null,
      kind: "call",
      body: notificationText({
        kind: "call",
        name: contact?.name || "",
        company: contact?.company || "",
        phone: e164,
        url: contact ? threadUrl(contact.id) : getSettings().publicUrl,
      }),
    });
  } catch (err) {
    console.error("[sms] call notify failed", err);
  }
}
