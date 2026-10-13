import fs from "fs";
import path from "path";
import { config } from "./config";
import { insertInboundVerify, type InboundVerifyRow } from "./db";
import { publish } from "./bus";
import { isElksMediaUrl } from "./elks";

function authHeader(): string {
  const user = config.elksApiUsername;
  const pass = config.elksApiPassword;
  if (!user || !pass) throw new Error("Missing 46ELKS credentials");
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

/** English + Swedish spoken digit words → 0-9. */
const DIGIT_WORDS: Record<string, string> = {
  zero: "0",
  oh: "0",
  noll: "0",
  one: "1",
  won: "1",
  ett: "1",
  en: "1",
  two: "2",
  to: "2",
  too: "2",
  två: "2",
  tva: "2",
  three: "3",
  tree: "3",
  tre: "3",
  four: "4",
  for: "4",
  fyra: "4",
  five: "5",
  fem: "5",
  six: "6",
  sex: "6",
  seven: "7",
  sju: "7",
  eight: "8",
  ate: "8",
  åtta: "8",
  atta: "8",
  nine: "9",
  nio: "9",
};

/**
 * Pull a 6-digit OTP from a transcript.
 * Handles: "123456", "1 2 3 4 5 6", "12-34-56", "one two three…", "ett två tre…".
 * Prefers exact 6 digits; falls back to longest digit run of length 4–8 (caller can edit).
 */
export function extractOtp(text: string): string | null {
  if (!text?.trim()) return null;

  // 1) Compact pure digits (strips spaces/punctuation between digits)
  const compact = text.replace(/[\s,.\-_/|]+/g, "");
  const six = compact.match(/\d{6}/);
  if (six) return six[0];

  // 2) Spaced / punctuated digit runs: "1 2 3 4 5 6" or "1,2,3,4,5,6"
  const spaced = text.match(/(?:\d[\s,.\-_/|]*){4,8}/g);
  if (spaced) {
    for (const run of spaced) {
      const digits = run.replace(/\D/g, "");
      if (digits.length === 6) return digits;
    }
    // best near-miss (e.g. only 3–5 captured) — still surface it
    const best = spaced
      .map((r) => r.replace(/\D/g, ""))
      .filter((d) => d.length >= 4 && d.length <= 8)
      .sort((a, b) => b.length - a.length)[0];
    if (best?.length === 6) return best;
  }

  // 3) Spoken words → digits
  const tokens = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9åäö]+/i)
    .filter(Boolean);
  const fromWords: string[] = [];
  for (const t of tokens) {
    if (/^\d$/.test(t)) fromWords.push(t);
    else if (DIGIT_WORDS[t]) fromWords.push(DIGIT_WORDS[t]);
  }
  if (fromWords.length >= 6) return fromWords.slice(0, 6).join("");
  // All consecutive digit chars found in order (last resort)
  const allDigits = text.replace(/\D/g, "");
  if (allDigits.length === 6) return allDigits;
  if (allDigits.length > 6) {
    // prefer a 6-run if present, else first 6
    const m = allDigits.match(/\d{6}/);
    return m ? m[0] : allDigits.slice(0, 6);
  }
  return null;
}

/** All digits heard (for UI when full OTP not recovered). */
export function extractDigits(text: string): string {
  if (!text) return "";
  const tokens = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9åäö]+/i)
    .filter(Boolean);
  const out: string[] = [];
  for (const t of tokens) {
    if (/^\d$/.test(t)) out.push(t);
    else if (DIGIT_WORDS[t]) out.push(DIGIT_WORDS[t]);
    else if (/^\d+$/.test(t)) out.push(...t.split(""));
  }
  if (out.length) return out.join("");
  return text.replace(/\D/g, "");
}

async function openrouter(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openrouterApiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) growzilla-dialer",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<Record<string, unknown>>;
}

async function transcribeWav(filePath: string): Promise<string> {
  if (!config.openrouterApiKey) throw new Error("Missing OPENROUTER_API_KEY for voice OTP transcription");
  const data = await openrouter({
    model: "google/gemini-2.5-flash",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "This is a phone call where a verification code is spoken digit-by-digit " +
              "(English or Swedish: one/ett, two/två, three/tre, four/fyra, five/fem, six/sex, " +
              "seven/sju, eight/åtta, nine/nio, zero/noll). " +
              "Transcribe EVERY digit you hear, in order. " +
              "Prefer writing digits as arabic numerals separated by spaces (e.g. '1 2 3 4 5 6'). " +
              "Do not invent digits that are not audible. Output ONLY the transcription.",
          },
          {
            type: "input_audio",
            input_audio: { data: fs.readFileSync(filePath).toString("base64"), format: "wav" },
          },
        ],
      },
    ],
  });
  const choices = data.choices as { message?: { content?: string } }[] | undefined;
  return String(choices?.[0]?.message?.content ?? "");
}

/** Download 46elks recording, transcribe, extract OTP, store + SSE. */
export async function processVerifyRecording(opts: {
  callid: string;
  wavUrl: string;
  from?: string;
  to?: string;
}): Promise<InboundVerifyRow | null> {
  // Webhook-supplied values: only ever send our 46elks credentials to 46elks, and never let
  // callid escape the recordings dir.
  if (!isElksMediaUrl(opts.wavUrl)) throw new Error(`refusing non-46elks recording URL: ${opts.wavUrl.slice(0, 80)}`);
  const safeId = opts.callid.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  if (!safeId) throw new Error("invalid callid");

  const dir = path.join(path.dirname(config.dbPath), "verify-recordings");
  fs.mkdirSync(dir, { recursive: true });
  const localPath = path.join(dir, `${safeId}.wav`);

  const res = await fetch(opts.wavUrl, {
    headers: { Authorization: authHeader() },
    cache: "no-store",
    redirect: "error", // a redirect would re-send the Authorization header off-host
  });
  if (!res.ok) throw new Error(`wav fetch HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 4000) throw new Error("recording too short");
  fs.writeFileSync(localPath, buf);

  const transcript = await transcribeWav(localPath);
  const code = extractOtp(transcript);
  const digits = extractDigits(transcript);
  const fromE164 = opts.from?.startsWith("+") ? opts.from : opts.from ? `+${opts.from}` : null;

  // Prefer full 6-digit OTP; if we only heard a partial run, still surface digits in transcript line.
  const displayTranscript =
    !code && digits
      ? `${transcript.trim()}  [digits heard: ${digits} (${digits.length}/6)]`
      : transcript;

  const row = insertInboundVerify({
    id: `verify-${opts.callid}`,
    callid: opts.callid,
    from_e164: fromE164,
    code,
    transcript: displayTranscript,
    wav_path: localPath,
  });

  publish({
    type: "verify",
    payload: {
      code,
      digits,
      transcript: displayTranscript,
      from: fromE164,
      callid: opts.callid,
      status: code ? "code" : digits ? "partial" : "transcript",
    },
  });

  return row ?? null;
}