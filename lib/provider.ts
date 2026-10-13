import { config } from "./config";
import { getDb } from "./db";
import { toE164 } from "./phone";

export type DialerProvider = "vonage" | "46elks";
/** off | listen (answer+record voice OTP) | missed (reject + CLI last digits) | forward (bridge to operator) */
export type ElksVerifyMode = "off" | "listen" | "missed" | "forward";

declare global {
  // eslint-disable-next-line no-var
  var __dialerProvider: DialerProvider | undefined;
  // eslint-disable-next-line no-var
  var __callerIdOverride: "US" | "SE" | null | undefined;
  // eslint-disable-next-line no-var
  var __elksWebhookBase: string | undefined;
  // eslint-disable-next-line no-var
  var __operatorPhone: string | undefined;
  // eslint-disable-next-line no-var
  var __elksForwardInbound: boolean | undefined;
  // eslint-disable-next-line no-var
  var __elksVerifyMode: ElksVerifyMode | undefined;
}

/** Active telephony backend — env default, overridable per session via POST /api/provider. */
export function getDialerProvider(): DialerProvider {
  if (!globalThis.__dialerProvider) globalThis.__dialerProvider = config.dialerProvider;
  return globalThis.__dialerProvider;
}

export function setDialerProvider(p: DialerProvider): void {
  globalThis.__dialerProvider = p;
}

/** Public base URL for 46elks whenhangup / voice_start webhooks (set by tunnel). */
export function getElksWebhookBase(): string | null {
  return globalThis.__elksWebhookBase ?? process.env.ELKS_WEBHOOK_BASE ?? null;
}

export function setElksWebhookBase(url: string): void {
  globalThis.__elksWebhookBase = url.replace(/\/$/, "");
}

export function getCallerIdOverride(): "US" | "SE" | null {
  return globalThis.__callerIdOverride ?? null;
}

export function setCallerIdOverride(region: "US" | "SE" | null): void {
  globalThis.__callerIdOverride = region;
}

/** Operator mobile — env default, overridable at runtime via POST /api/operator-phone. */
export function getOperatorPhone(): string {
  return globalThis.__operatorPhone || config.operatorPhone || "";
}

export function setOperatorPhone(raw: string): string | null {
  const e164 = toE164(raw, "SE");
  if (!e164) return null;
  globalThis.__operatorPhone = e164;
  return e164;
}

export function clearOperatorPhone(): void {
  globalThis.__operatorPhone = undefined;
}

/** Meta/WhatsApp OTP capture: listen / missed-call CLI / forward to operator. */
export function getElksVerifyMode(): ElksVerifyMode {
  if (globalThis.__elksVerifyMode) return globalThis.__elksVerifyMode;
  const row = getDb().prepare("SELECT value FROM meta WHERE key='elks_verify_mode'").get() as
    | { value?: string }
    | undefined;
  const mode = row?.value;
  if (mode === "listen" || mode === "forward" || mode === "missed") globalThis.__elksVerifyMode = mode;
  else globalThis.__elksVerifyMode = "off";
  return globalThis.__elksVerifyMode;
}

export function setElksVerifyMode(mode: ElksVerifyMode): void {
  globalThis.__elksVerifyMode = mode;
  globalThis.__elksForwardInbound = mode === "forward";
  getDb()
    .prepare(
      "INSERT INTO meta (key, value) VALUES ('elks_verify_mode', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    )
    .run(mode);
}

/** @deprecated use getElksVerifyMode() === "forward" */
export function getElksForwardInbound(): boolean {
  return getElksVerifyMode() === "forward" || globalThis.__elksForwardInbound === true;
}

export function setElksForwardInbound(enabled: boolean): void {
  setElksVerifyMode(enabled ? "forward" : "off");
}