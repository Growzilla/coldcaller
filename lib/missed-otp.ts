/**
 * Meta/WhatsApp "Missed call" verification:
 * Meta places a short flash call and hangs up. The OTP is the last N digits of
 * the inbound caller ID (CLI). We must NOT answer — only capture the CLI.
 *
 * Digit count varies by region/carrier; common is last 4–6. We surface all
 * candidates so the operator can try the one Meta's form expects.
 */

export type MissedOtpCandidates = {
  /** E.164 or best-effort from number */
  fromE164: string | null;
  /** Digits only of CLI (no country formatting) */
  digits: string;
  /** Preferred single code (last 6 if available, else last 4/5) */
  code: string | null;
  /** All useful candidates, longest first: last6, last5, last4 */
  candidates: string[];
  /** Human label for the inbox */
  transcript: string;
};

/** Normalize a 46elks `from` field into digits + optional E.164. */
export function normalizeCallerId(raw: string | null | undefined): {
  fromE164: string | null;
  digits: string;
} {
  if (!raw) return { fromE164: null, digits: "" };
  const s = String(raw).trim();
  const digits = s.replace(/\D/g, "");
  if (!digits) return { fromE164: null, digits: "" };
  const fromE164 = s.startsWith("+") ? `+${digits}` : digits.length >= 8 ? `+${digits}` : null;
  return { fromE164, digits };
}

/**
 * Build OTP candidates from an inbound caller ID.
 * Returns null if we don't have enough digits to form a code.
 */
export function extractMissedCallOtp(rawFrom: string | null | undefined): MissedOtpCandidates | null {
  const { fromE164, digits } = normalizeCallerId(rawFrom);
  if (digits.length < 4) return null;

  const candidates: string[] = [];
  for (const n of [6, 5, 4] as const) {
    if (digits.length >= n) {
      const c = digits.slice(-n);
      if (!candidates.includes(c)) candidates.push(c);
    }
  }
  if (!candidates.length) return null;

  // Prefer 6 when available (WhatsApp codes are often 6); else longest.
  const code = candidates.find((c) => c.length === 6) ?? candidates[0] ?? null;

  const transcript = [
    "Missed-call CLI",
    fromE164 ?? digits,
    "→ try last digits:",
    candidates.map((c) => c).join(" / "),
  ].join(" ");

  return { fromE164, digits, code, candidates, transcript };
}
