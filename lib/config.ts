import fs from "fs";
import path from "path";
import os from "os";

// Fallback: pull Vonage creds from the workspace-level .env if not set locally.
const WORKSPACE_ENV = "/home/god0fm0ney/dev/.env";

function parseEnvFile(file: string): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
    return out;
  } catch {
    return {};
  }
}

/** Token stored in its own chmod-600 file (the /ghl skill keeps the Anvil Systems PIT there). */
function readTokenFile(file: string): string {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

const workspace = parseEnvFile(WORKSPACE_ENV);
// Next.js loads .env.local into process.env by itself, but tsx scripts don't — parse it here too.
const local = parseEnvFile(path.join(process.cwd(), ".env.local"));

function env(key: string, fallback = ""): string {
  return process.env[key] || local[key] || workspace[key] || fallback;
}

export const config = {
  /** Default telephony backend — overridable at runtime via POST /api/provider. */
  dialerProvider: (["46elks", "twilio"].includes(env("DIALER_PROVIDER", "vonage"))
    ? env("DIALER_PROVIDER")
    : "vonage") as "vonage" | "46elks" | "twilio",
  /* Twilio — REST + webhook signatures use SID/token; the browser line needs an API key pair. */
  twilioAccountSid: env("TWILIO_ACCOUNT_SID"),
  twilioAuthToken: env("TWILIO_AUTH_TOKEN"),
  twilioApiKeySid: env("TWILIO_API_KEY_SID"),
  twilioApiKeySecret: env("TWILIO_API_KEY_SECRET"),
  /** Twilio-owned number (E.164) — caller ID on every lead leg. */
  twilioNumber: env("TWILIO_NUMBER"),
  /** Browser Device identity — Twilio rings `client:<identity>` for each dial. */
  twilioClientIdentity: env("TWILIO_CLIENT_IDENTITY", "rapiddial-operator"),
  elksApiUsername: env("46ELKS_API_USERNAME"),
  elksApiPassword: env("46ELKS_API_PASSWORD"),
  elksNumber: env("46ELKS_NUMBER", "+46766861525"),
  elksNumberId: env("46ELKS_NUMBER_ID", "n55db66883374c1cb192f4e2dfa1ded0a"),
  /** JsSIP WebRTC password from 46elks dashboard → Numbers → edit. */
  elksWebrtcSecret: env("46ELKS_WEBRTC_SECRET"),
  /** Optional override; defaults to elksNumber digits without '+'. */
  elksWebrtcUser: env("46ELKS_WEBRTC_USER"),
  /** Optional override for the 46elks webhook token (default: derived from the API password). */
  elksWebhookSecret: env("ELKS_WEBHOOK_SECRET"),
  vonageApiKey: env("VONAGE_REAL_KEY") || env("VONAGE_API_KEY"),
  vonageApiSecret: env("VONAGE_API_SECRET"),
  applicationId: env("VONAGE_APPLICATION_ID"),
  privateKeyPath: env(
    "VONAGE_PRIVATE_KEY_PATH",
    path.join(process.cwd(), "secrets", "private.key")
  ),
  /** Vonage-owned LVN — outbound caller ID on both legs. */
  vonageNumber: env("VONAGE_NUMBER", "+46790952801"),
  /**
   * Regional Voice API host. The browser Client SDK leg connects to api-us-3; server-created
   * legs MUST use the same region or a same-named conversation resolves to a DIFFERENT room and
   * the two legs can't hear each other. Proven via scripts/audio-bridge-harness.mjs.
   */
  vonageApiHost: env("VONAGE_API_HOST", "https://api-us-3.vonage.com"),
  /** Albert's mobile — leg A of every session. */
  operatorPhone: env("OPERATOR_PHONE"),
  dbPath: env("DIALER_DB", path.join(process.cwd(), "data", "dialer.db")),
  /* Call intelligence — OpenRouter preferred (OPENAI_API_KEY is dead as of 2026-06-12) */
  openaiApiKey: env("OPENAI_API_KEY"),
  openrouterApiKey: env("OPENROUTER_API_KEY"),
  resendApiKey: env("RESEND_API_KEY"),
  bookingUrl: env("BOOKING_URL", "https://calendly.com/albert-growzilla/growzilla-demo"),
  bookingFrom: env("BOOKING_FROM", "Albert <albert@growzilla.xyz>"),
  calendlyToken: env("CALENDLY_TOKEN"), // optional — enables booked-detection when set
  /* GoHighLevel — GHL is the lead master; the dialer pulls its queue and writes outcomes back */
  /** Sub-account Private Integration Token (Settings → Private Integrations). Empty = sync off. */
  ghlToken: env("GHL_PRIVATE_TOKEN") || readTokenFile(env("GHL_TOKEN_FILE", path.join(os.homedir(), ".config/ghl/anvil_systems_pit"))),
  /** Default: Anvil Systems sub-account (the location the leads-engine import writes to). */
  ghlLocationId: env("GHL_LOCATION_ID", "DebmRaelW8ZFd0sGQG4v"),
  /** Pipeline the dialer works, matched by name (stages too — see lib/ghl.ts STAGES). */
  ghlPipelineName: env("GHL_PIPELINE_NAME", "Outbound"),
  /** This operator's GHL user id — queue pull filters on it, new opportunities get assigned to it. */
  ghlUserId: env("GHL_USER_ID", "LHS2dyB4LUChw6in1ANT"),
  /** Sole traders (tag nix-required) need a NIX-Telefon wash first — kept out of the queue unless "1". */
  ghlIncludeNix: env("GHL_INCLUDE_NIX") === "1",
};

/**
 * Hardcoded caller IDs per region. Both numbers are owned on the Vonage account
 * and linked to the voice app. Outbound caller ID is auto-picked from the lead's
 * country (US/Canada → US number, Sweden/Nordic → SE number) so a US prospect
 * never sees a +46 foreign number — that tanks pickup. Override per-session via
 * the header toggle (POST /api/callerid).
 */
export const CALLER_IDS: Record<"US" | "SE", string> = {
  US: "+12088587571", // US LVN — US & Canadian prospects (Vonage only)
  SE: "+46790952801", // Swedish LVN — Vonage default
};

/** Swedish caller ID when provider=46elks. */
export const ELKS_CALLER_ID = env("46ELKS_NUMBER", "+46766861525");

/** Map a lead's country to the right caller ID region. */
export function callerRegionForCountry(country?: string | null): "US" | "SE" {
  const c = (country || "").toLowerCase();
  if (/united states|u\.?s\.?a?\b|canada|america/.test(c)) return "US";
  return "SE";
}

/** Resolve the caller ID number for a lead's country (honors a manual override). */
export function callerIdForCountry(
  country?: string | null,
  override?: "US" | "SE" | null,
  provider: "vonage" | "46elks" | "twilio" = "vonage"
): string {
  if (provider === "46elks") return ELKS_CALLER_ID;
  if (provider === "twilio") return config.twilioNumber;
  if (override) return CALLER_IDS[override];
  return CALLER_IDS[callerRegionForCountry(country)];
}

export function privateKey(): string {
  return fs.readFileSync(config.privateKeyPath, "utf8");
}

export function assertCallReady(): string | null {
  if (!config.vonageApiKey || !config.vonageApiSecret)
    return "Missing VONAGE_API_KEY / VONAGE_API_SECRET";
  if (!config.applicationId) return "Missing VONAGE_APPLICATION_ID — run: npm run setup";
  if (!fs.existsSync(config.privateKeyPath))
    return `Missing private key at ${config.privateKeyPath} — run: npm run setup`;
  if (!(globalThis.__operatorPhone || config.operatorPhone))
    return "Set your mobile number (cockpit header or OPERATOR_PHONE in .env.local)";
  return null;
}
