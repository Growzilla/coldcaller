/**
 * Unified telephony facade — routes to Vonage or 46elks based on active provider.
 * API routes import from here so Vonage behaviour stays untouched when provider=vonage.
 */
import { getDialerProvider, type DialerProvider } from "./provider";
import { assertCallReady, config } from "./config";
import { assertElksReady, getBalanceSek } from "./elks";
import { assertElksRtcReady } from "./elks-rtc";
import * as vonage from "./vonage";
import * as elksDialer from "./elks-dialer";

export {
  getDialerProvider,
  setDialerProvider,
  getCallerIdOverride,
  setCallerIdOverride,
  getOperatorPhone,
  setOperatorPhone,
  clearOperatorPhone,
} from "./provider";
export type { DialerProvider } from "./provider";

// Re-export Vonage-only helpers still used by vonage webhooks
export { roomName, markSessionLive } from "./vonage";

function backend() {
  return getDialerProvider() === "46elks" ? elksDialer : vonage;
}

export async function startSession(mode: "phone" | "rtc" = "phone") {
  return backend().startSession(mode);
}

export async function endSession() {
  return backend().endSession();
}

export async function dialLead(leadId: number) {
  return backend().dialLead(leadId);
}

export async function hangupActiveCall() {
  return backend().hangupActiveCall();
}

export async function runLineCheck() {
  return backend().runLineCheck();
}

export async function sendDtmf(digits: string) {
  return backend().sendDtmf(digits);
}

export function assertDialerReady(mode: "phone" | "rtc" = "phone"): string | null {
  if (getDialerProvider() === "46elks") {
    if (mode === "rtc") return assertElksRtcReady() ?? assertElksReady("rtc");
    return assertElksReady("phone");
  }
  return assertCallReady();
}

export async function getProviderBalance(): Promise<{ amount: number; currency: string } | null> {
  if (getDialerProvider() === "46elks") {
    const sek = await getBalanceSek();
    return sek !== null ? { amount: sek, currency: "SEK" } : null;
  }
  try {
    if (!config.vonageApiKey || !config.vonageApiSecret) return null;
    const res = await fetch(
      `https://rest.nexmo.com/account/get-balance?api_key=${config.vonageApiKey}&api_secret=${encodeURIComponent(config.vonageApiSecret)}`,
      { cache: "no-store" }
    );
    if (!res.ok) return null;
    const value = Number((await res.json()).value);
    return Number.isFinite(value) ? { amount: value, currency: "EUR" } : null;
  } catch {
    return null;
  }
}