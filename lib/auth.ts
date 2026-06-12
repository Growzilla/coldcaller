/**
 * Cookie + bearer auth shared by middleware.ts (edge runtime) and /api/login (node).
 * Uses ONLY Web Crypto + process.env so it runs in both runtimes — no fs, no lib/config.
 * When DIALER_PASSWORD is unset (local dev), the middleware disables auth entirely.
 */

export const AUTH_COOKIE = "dialer_auth";
const COOKIE_TTL_S = 30 * 24 * 60 * 60; // 30 days

const enc = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Mint a cookie value "<expiryEpochSeconds>.<hmac>" signed with the dialer password. */
export async function mintAuthCookie(password: string): Promise<{ value: string; maxAge: number }> {
  const exp = Math.floor(Date.now() / 1000) + COOKIE_TTL_S;
  const sig = await hmacHex(password, `rapiddial-auth-v1:${exp}`);
  return { value: `${exp}.${sig}`, maxAge: COOKIE_TTL_S };
}

/** Verify a cookie value minted by mintAuthCookie. Rotating the password invalidates all cookies. */
export async function verifyAuthCookie(password: string, value: string | undefined): Promise<boolean> {
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot <= 0) return false;
  const exp = Number(value.slice(0, dot));
  const sig = value.slice(dot + 1);
  if (!Number.isFinite(exp) || !sig || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = await hmacHex(password, `rapiddial-auth-v1:${exp}`);
  if (sig.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
