import fs from "fs";
import path from "path";

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

const workspace = parseEnvFile(WORKSPACE_ENV);
// Next.js loads .env.local into process.env by itself, but tsx scripts don't — parse it here too.
const local = parseEnvFile(path.join(process.cwd(), ".env.local"));

function env(key: string, fallback = ""): string {
  return process.env[key] || local[key] || workspace[key] || fallback;
}

export const config = {
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
};

/**
 * Hardcoded caller IDs per region. Both numbers are owned on the Vonage account
 * and linked to the voice app. Outbound caller ID is auto-picked from the lead's
 * country (US/Canada → US number, Sweden/Nordic → SE number) so a US prospect
 * never sees a +46 foreign number — that tanks pickup. Override per-session via
 * the header toggle (POST /api/callerid).
 */
export const CALLER_IDS: Record<"US" | "SE", string> = {
  US: "+12088587571", // US LVN — US & Canadian prospects
  SE: "+46790952801", // Swedish LVN — Sweden & Nordic prospects
};

/** Map a lead's country to the right caller ID region. */
export function callerRegionForCountry(country?: string | null): "US" | "SE" {
  const c = (country || "").toLowerCase();
  if (/united states|u\.?s\.?a?\b|canada|america/.test(c)) return "US";
  return "SE";
}

/** Resolve the caller ID number for a lead's country (honors a manual override). */
export function callerIdForCountry(country?: string | null, override?: "US" | "SE" | null): string {
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
  if (!config.operatorPhone)
    return "Missing OPERATOR_PHONE in .env.local (your mobile, E.164 e.g. +467XXXXXXXX)";
  return null;
}
