import crypto from "crypto";

export function smsPassword(): string {
  return process.env.SMS_APP_PASSWORD || "";
}

export function authRequired(): boolean {
  return smsPassword().length > 0;
}

export function sessionToken(): string {
  return crypto.createHmac("sha256", smsPassword()).update("sms-campaign-v1").digest("hex");
}

export function smsAuthOk(req: Request): boolean {
  if (!authRequired()) return true;
  const cookie = req.headers.get("cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)sms_session=([^;]+)/);
  const got = match?.[1] ? decodeURIComponent(match[1]) : "";
  const expected = sessionToken();
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

export function sessionCookie(token: string, maxAge = 60 * 60 * 24 * 14): string {
  const secure = (process.env.SMS_PUBLIC_URL || "").startsWith("https://");
  return `sms_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
