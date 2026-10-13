import crypto from "crypto";
import { config } from "./config";
import { getOperatorPhone } from "./provider";

/** One bridged leg created by a `connect` action (GET /a1/calls/{id} → legs[]). */
export type ElksLeg = {
  from?: string;
  to?: string;
  state?: string;
  duration?: number;
};

export type ElksCall = {
  id: string;
  direction: string;
  from: string;
  to: string;
  state: string;
  created?: string;
  /** Time the call (operator leg) was picked up. */
  start?: string;
  duration?: number;
  cost?: number;
  /** Actions executed so far; a connect entry carries `result` = success | busy | failed once done. */
  actions?: (string | Record<string, unknown>)[];
  legs?: ElksLeg[];
};

/**
 * Shared secret appended as `?k=` to every webhook URL we hand 46elks. Derived from the API
 * password so the Next server and the tunnel script (separate processes) agree without a new
 * env var; override with ELKS_WEBHOOK_SECRET. Never the password itself.
 */
export function elksWebhookToken(): string {
  const explicit = config.elksWebhookSecret;
  if (explicit) return explicit;
  if (!config.elksApiPassword) return "";
  return crypto.createHmac("sha256", config.elksApiPassword).update("coldcaller-elks-webhook").digest("hex").slice(0, 32);
}

/** Append the webhook token to a URL we register with / return to 46elks. */
export function signWebhookUrl(url: string): string {
  const token = elksWebhookToken();
  if (!token) return url;
  const u = new URL(url);
  u.searchParams.set("k", token);
  return u.toString();
}

/** True when the request carries the webhook token (constant-time compare). */
export function isSignedWebhook(req: Request): boolean {
  const token = elksWebhookToken();
  if (!token) return false;
  const got = new URL(req.url).searchParams.get("k") ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Strip the token before echoing a configured webhook URL to the cockpit/CLI. */
export function redactWebhookUrl(url: string | null): string | null {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (u.searchParams.has("k")) u.searchParams.set("k", "redacted");
    return u.toString();
  } catch {
    return url;
  }
}

/** Recording/media URLs we may fetch WITH our API credentials — 46elks hosts over https only. */
export function isElksMediaUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && (u.hostname === "46elks.com" || u.hostname.endsWith(".46elks.com"));
  } catch {
    return false;
  }
}

function authHeader(): string {
  const user = config.elksApiUsername;
  const pass = config.elksApiPassword;
  if (!user || !pass) throw new Error("Missing 46ELKS_API_USERNAME / 46ELKS_API_PASSWORD");
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

async function elksFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", authHeader());
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/x-www-form-urlencoded");
  return fetch(`https://api.46elks.com/a1${path}`, { ...init, headers, cache: "no-store" });
}

/** POST /a1/calls — initiate an outbound call. */
export async function makeCall(opts: {
  from: string;
  to: string;
  voiceStart: string | Record<string, unknown>;
  whenhangup?: string;
  timeout?: number;
}): Promise<ElksCall> {
  const body = new URLSearchParams({
    from: opts.from,
    to: opts.to,
    voice_start: typeof opts.voiceStart === "string" ? opts.voiceStart : JSON.stringify(opts.voiceStart),
  });
  if (opts.whenhangup) body.set("whenhangup", opts.whenhangup);
  if (opts.timeout) body.set("timeout", String(opts.timeout));

  const res = await elksFetch("/calls", { method: "POST", body });
  const text = await res.text();
  if (!res.ok) throw new Error(`46elks makeCall HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as ElksCall;
}

/** GET /a1/calls/{id} */
export async function getCall(id: string): Promise<ElksCall | null> {
  const res = await elksFetch(`/calls/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`46elks getCall HTTP ${res.status}`);
  return (await res.json()) as ElksCall;
}

/** DELETE /a1/calls/{id} — hang up an active call. */
export async function hangupCall(id: string): Promise<void> {
  const res = await elksFetch(`/calls/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "");
    throw new Error(`46elks hangup HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

/** GET /a1/me — account balance in 1/10000 SEK units. */
export async function getBalanceSek(): Promise<number | null> {
  try {
    const res = await elksFetch("/me");
    if (!res.ok) return null;
    const data = (await res.json()) as { balance?: number };
    const raw = Number(data.balance);
    return Number.isFinite(raw) ? raw / 10000 : null;
  } catch {
    return null;
  }
}

/** POST /a1/numbers/{id} — point voice_start at our inbound webhook. */
export async function configureNumberVoiceStart(numberId: string, voiceStartUrl: string): Promise<void> {
  const res = await elksFetch(`/numbers/${encodeURIComponent(numberId)}`, {
    method: "POST",
    body: new URLSearchParams({ voice_start: voiceStartUrl }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`46elks configureNumber HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

/** POST /a1/numbers/{id} — point sms_url at our inbound SMS webhook. */
export async function configureNumberSmsUrl(numberId: string, smsUrl: string): Promise<void> {
  const res = await elksFetch(`/numbers/${encodeURIComponent(numberId)}`, {
    method: "POST",
    body: new URLSearchParams({ sms_url: smsUrl, sms_replies: "no" }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`46elks configureNumber sms_url HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

export type ElksSms = {
  id: string;
  direction: string;
  from: string;
  to: string;
  message: string;
  created?: string;
  status?: string;
};

/** GET /a1/sms — SMS history (backup if webhook missed). */
export async function listSms(opts: { to?: string; limit?: number } = {}): Promise<ElksSms[]> {
  const params = new URLSearchParams();
  if (opts.to) params.set("to", opts.to);
  if (opts.limit) params.set("limit", String(Math.min(opts.limit, 100)));
  const q = params.toString();
  const res = await elksFetch(`/sms${q ? `?${q}` : ""}`);
  if (!res.ok) throw new Error(`46elks listSms HTTP ${res.status}`);
  const data = (await res.json()) as { data?: ElksSms[] };
  return data.data ?? [];
}

/** POST /a1/sms — send a text from our 46elks number. */
export async function sendSms(opts: { to: string; message: string; whendelivered?: string }): Promise<{
  id: string;
  status?: string;
  cost?: number;
  parts?: number;
  created?: string;
}> {
  const body = new URLSearchParams({ from: config.elksNumber, to: opts.to, message: opts.message });
  if (opts.whendelivered) body.set("whendelivered", opts.whendelivered);
  const res = await elksFetch("/sms", { method: "POST", body });
  const text = await res.text();
  if (!res.ok) throw new Error(`46elks sendSms HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** GET /a1/numbers — every number on the account (includes `secret` on WebRTC/SIP numbers). */
export async function listNumbers(): Promise<Record<string, unknown>[]> {
  const res = await elksFetch("/numbers");
  if (!res.ok) throw new Error(`46elks listNumbers HTTP ${res.status}`);
  const data = (await res.json()) as { data?: Record<string, unknown>[] };
  return data.data ?? [];
}

/** GET /a1/numbers/{id} */
export async function getNumber(id: string): Promise<Record<string, unknown> | null> {
  const res = await elksFetch(`/numbers/${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  return (await res.json()) as Record<string, unknown>;
}

export function assertElksReady(mode: "phone" | "rtc" = "phone"): string | null {
  if (!config.elksApiUsername || !config.elksApiPassword)
    return "Missing 46ELKS_API_USERNAME / 46ELKS_API_PASSWORD in .env";
  if (!config.elksNumber) return "Missing 46ELKS_NUMBER (Swedish caller ID)";
  if (mode === "rtc") return null; // rtc readiness checked separately
  if (!getOperatorPhone()) return "Set your mobile number (header field or OPERATOR_PHONE in .env.local)";
  return null;
}