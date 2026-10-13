import { config } from "./config";
import { getNumber, listNumbers } from "./elks";

declare global {
  // eslint-disable-next-line no-var
  var __elksWebrtcSecret: string | undefined;
  // eslint-disable-next-line no-var
  var __elksWebrtcUser: string | undefined;
}

/**
 * SIP username — 46elks wants the number without '+'. The browser line is a SEPARATE 46elks
 * WebRTC number (category webrtc, e.g. +4600…), not the +46766861525 caller ID: the PSTN number
 * has no `webrtc` capability. Env override > number discovered on the account > legacy fallback.
 */
export function elksWebrtcUser(): string {
  const explicit = envDigits(config.elksWebrtcUser);
  if (explicit) return explicit;
  if (globalThis.__elksWebrtcUser) return globalThis.__elksWebrtcUser;
  return config.elksNumber.replace(/^\+/, "");
}

/**
 * Find the account's WebRTC client number and cache its SIP user + secret. Returns null when the
 * account has none (allocate one: `npm run elks:webrtc -- --allocate` → POST /a1/numbers country=se capabilities=webrtc).
 */
export async function discoverWebrtcNumber(): Promise<{ user: string; secret: string } | null> {
  try {
    const nums = await listNumbers();
    const n = nums.find(
      (x) =>
        x.active === "yes" &&
        Array.isArray(x.capabilities) &&
        (x.capabilities as string[]).includes("webrtc") &&
        typeof x.secret === "string"
    );
    if (!n) return null;
    const user = String(n.number).replace(/^\+/, "");
    globalThis.__elksWebrtcUser = user;
    if (!config.elksWebrtcSecret) globalThis.__elksWebrtcSecret = String(n.secret).trim();
    return { user, secret: String(n.secret).trim() };
  } catch {
    return null;
  }
}

function envDigits(raw: string): string {
  return raw.replace(/^\+/, "").trim();
}

/** Discover once per server lifetime (unless env pins the user) — dialLead needs the SIP user synchronously. */
export async function ensureWebrtcNumber(): Promise<void> {
  if (envDigits(config.elksWebrtcUser) || globalThis.__elksWebrtcUser) return;
  await discoverWebrtcNumber();
}

export function elksWebrtcPassword(): string {
  return globalThis.__elksWebrtcSecret || config.elksWebrtcSecret || "";
}

export function setElksWebrtcSecret(secret: string): void {
  globalThis.__elksWebrtcSecret = secret;
}

export function assertElksRtcReady(): string | null {
  if (!config.elksApiUsername || !config.elksApiPassword)
    return "Missing 46ELKS_API_USERNAME / 46ELKS_API_PASSWORD";
  if (!config.elksNumber) return "Missing 46ELKS_NUMBER";
  const pass = elksWebrtcPassword();
  if (!pass) {
    return (
      "No 46elks WebRTC number on the account — top up 46elks (≥30 SEK), then run " +
      "`npm run elks:webrtc -- --allocate` (30 SEK/month) and Start line again"
    );
  }
  return null;
}

/** Browser-safe creds for JsSIP registration. */
export function elksRtcCredentials() {
  const user = elksWebrtcUser();
  return {
    user,
    password: elksWebrtcPassword(),
    sipUri: `sip:${user}@voip.46elks.com`,
    websocket: "wss://voip.46elks.com/w1/websocket",
    number: config.elksNumber,
  };
}

/** Try to read WebRTC secret from the account's WebRTC number (or the configured number object). */
export async function fetchWebrtcSecretFromApi(): Promise<string | null> {
  const found = await discoverWebrtcNumber();
  if (found) return found.secret;
  if (!config.elksNumberId) return null;
  try {
    const data = await getNumber(config.elksNumberId);
    const secret = data?.secret;
    return typeof secret === "string" ? secret.trim() : null;
  } catch {
    return null;
  }
}