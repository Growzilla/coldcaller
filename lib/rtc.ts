import { tokenGenerate } from "@vonage/jwt";
import { config, privateKey } from "./config";
import { getVonage } from "./vonage";

/** The single in-app identity Albert's browser logs in as. */
export const OPERATOR_USER = "operator";

/**
 * Create the Vonage user once (idempotent).
 * Raw call so we can read Vonage's real error body — the SDK collapses everything to
 * "Request failed with status code 400", and Vonage returns 400 `user:error:duplicate-name`
 * (NOT 409) once the user exists, which is the normal steady state and must be treated as success.
 */
export async function ensureOperatorUser(): Promise<void> {
  const jwt = tokenGenerate(config.applicationId, privateKey(), {});
  const res = await fetch("https://api.nexmo.com/v1/users", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: OPERATOR_USER, display_name: "RapidDial operator" }),
  });
  if (res.ok || res.status === 409) return;
  const body: any = await res.json().catch(() => ({}));
  // Duplicate name = user already exists = fine.
  if (/duplicate|already exists/i.test(String(body?.code || body?.detail || ""))) return;
  throw new Error(body?.detail || `Could not ensure operator user (HTTP ${res.status})`);
}

/** Short-lived JWT the browser uses to open a Client SDK session. */
export function mintClientToken(): string {
  return tokenGenerate(config.applicationId, privateKey(), {
    sub: OPERATOR_USER,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, // a full calling day
    acl: {
      paths: {
        "/*/users/**": {},
        "/*/conversations/**": {},
        "/*/sessions/**": {},
        "/*/devices/**": {},
        "/*/image/**": {},
        "/*/media/**": {},
        "/*/applications/**": {},
        "/*/push/**": {},
        "/*/knocking/**": {},
        "/*/legs/**": {},
      },
    },
  });
}
