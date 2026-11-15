import crypto from "crypto";
import { config, twilioNumberForLine } from "./config";
import { getTwilioLine } from "./provider";

/**
 * Minimal Twilio Voice REST client — no SDK, same shape as lib/elks.ts.
 * Auth: Account SID + Auth Token (REST + webhook signatures); API Key SID/secret (browser tokens).
 */

const API = "https://api.twilio.com/2010-04-01";

export type TwilioCall = {
  sid: string;
  parent_call_sid: string | null;
  status: string; // queued | ringing | in-progress | completed | busy | failed | no-answer | canceled
  direction: string;
  from: string;
  to: string;
  duration: string | null;
  start_time: string | null;
};

function authHeader(): string {
  return "Basic " + Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString("base64");
}

async function twilioFetch(path: string, init?: { method?: string; body?: URLSearchParams }) {
  return fetch(`${API}/Accounts/${config.twilioAccountSid}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: authHeader(),
      ...(init?.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: init?.body,
    cache: "no-store",
  });
}

async function ok<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Twilio ${what} HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/** POST /Calls — inline TwiML, status callbacks for every progress event. */
export async function makeCall(opts: {
  from: string;
  to: string;
  twiml: string;
  statusCallback?: string;
  timeout?: number;
}): Promise<TwilioCall> {
  const body = new URLSearchParams({ From: opts.from, To: opts.to, Twiml: opts.twiml });
  if (opts.timeout) body.set("Timeout", String(opts.timeout));
  if (opts.statusCallback) {
    body.set("StatusCallback", opts.statusCallback);
    for (const ev of ["initiated", "ringing", "answered", "completed"]) body.append("StatusCallbackEvent", ev);
  }
  return ok<TwilioCall>(await twilioFetch("/Calls.json", { method: "POST", body }), "create call");
}

export async function getCall(sid: string): Promise<TwilioCall | null> {
  const res = await twilioFetch(`/Calls/${encodeURIComponent(sid)}.json`);
  if (res.status === 404) return null;
  return ok<TwilioCall>(res, "get call");
}

/** Child legs of a call — the <Dial>ed lead leg lives here. */
export async function childCalls(parentSid: string): Promise<TwilioCall[]> {
  const res = await twilioFetch(`/Calls.json?ParentCallSid=${encodeURIComponent(parentSid)}&PageSize=20`);
  const data = await ok<{ calls?: TwilioCall[] }>(res, "list child calls");
  return data.calls ?? [];
}

/** End a call whatever its state (ringing → canceled, live → completed). Child legs drop with it. */
export async function hangupCall(sid: string): Promise<void> {
  const info = await getCall(sid).catch(() => null);
  if (!info || FINAL.has(info.status)) return;
  const status = info.status === "in-progress" ? "completed" : "canceled";
  const res = await twilioFetch(`/Calls/${encodeURIComponent(sid)}.json`, {
    method: "POST",
    body: new URLSearchParams({ Status: status }),
  });
  // Raced to completion between the read and the update → Twilio answers 400 "not in-progress".
  if (!res.ok && res.status !== 404 && res.status !== 400) await ok(res, "hangup");
}

export const FINAL = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);

/** Balance in account currency (usually USD). */
export async function getBalance(): Promise<{ amount: number; currency: string } | null> {
  try {
    const res = await twilioFetch("/Balance.json");
    if (!res.ok) return null;
    const data = (await res.json()) as { balance?: string; currency?: string };
    const amount = Number(data.balance);
    return Number.isFinite(amount) ? { amount, currency: data.currency || "USD" } : null;
  } catch {
    return null;
  }
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/**
 * Voice access token for the browser Device. Hand-rolled HS256 JWT in Twilio's format.
 * `applicationSid` adds the outgoing grant so Device.connect places the call. An inbound
 * `client:<identity>` invite is delivered to every registered tab, and any reject is SIP 486.
 */
export function voiceAccessToken(identity: string, applicationSid?: string, ttlSeconds = 3600): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { typ: "JWT", alg: "HS256", cty: "twilio-fpa;v=1" };
  const voice: Record<string, unknown> = { incoming: { allow: true } };
  if (applicationSid) voice.outgoing = { application_sid: applicationSid };
  const payload = {
    jti: `${config.twilioApiKeySid}-${now}`,
    iss: config.twilioApiKeySid,
    sub: config.twilioAccountSid,
    iat: now,
    nbf: now,
    exp: now + ttlSeconds,
    grants: { identity, voice },
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.createHmac("sha256", config.twilioApiKeySecret).update(unsigned).digest();
  return `${unsigned}.${b64url(sig)}`;
}

/** Create or update the TwiML App the browser calls. VoiceUrl must be the current tunnel. */
export async function upsertVoiceApp(existingSid: string | null, voiceUrl: string): Promise<string> {
  const body = new URLSearchParams({
    FriendlyName: "RapidDial browser",
    VoiceUrl: voiceUrl,
    VoiceMethod: "POST",
  });
  if (existingSid) {
    const res = await twilioFetch(`/Applications/${encodeURIComponent(existingSid)}.json`, { method: "POST", body });
    if (res.ok) return ((await res.json()) as { sid: string }).sid;
    if (res.status !== 404) await ok(res, "voice app");
  }
  const created = await ok<{ sid: string }>(await twilioFetch("/Applications.json", { method: "POST", body }), "voice app");
  return created.sid;
}

/**
 * X-Twilio-Signature check: base64(HMAC-SHA1(authToken, fullUrl + sorted POST key/values)).
 * `publicUrl` must be the URL Twilio called (the tunnel URL), not the localhost one Next sees.
 */
export function isValidTwilioSignature(signature: string | null, publicUrl: string, params: Record<string, string>): boolean {
  if (!signature || !config.twilioAuthToken) return false;
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], publicUrl);
  const expected = crypto.createHmac("sha1", config.twilioAuthToken).update(data).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** TwiML: bridge to the lead with our caller ID. */
export function dialTwiml(lead: string, callerId: string): string {
  return `<Response><Dial callerId="${esc(callerId)}" timeout="35"><Number>${esc(lead)}</Number></Dial></Response>`;
}

export function playTwiml(url: string, loops = 2): string {
  return `<Response><Play loop="${loops}">${esc(url)}</Play></Response>`;
}

/** Caller ID for the line selected at boot (Australia or Canada). */
export function activeTwilioNumber(): string {
  return twilioNumberForLine(getTwilioLine());
}

export function assertTwilioReady(mode: "phone" | "rtc"): string | null {
  if (!config.twilioAccountSid || !config.twilioAuthToken) return "Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN";
  if (!activeTwilioNumber()) return "Missing TWILIO_AUSTRALIA_NUMBER / TWILIO_CANADA_NUMBER (E.164)";
  if (mode === "rtc" && (!config.twilioApiKeySid || !config.twilioApiKeySecret))
    return "Browser line needs TWILIO_API_KEY_SID / TWILIO_API_KEY_SECRET (Twilio console → API keys)";
  return null;
}
