# RapidDial → Render Deployment — Handoff

> Last updated: 2026-06-13 (S53). Read this to resume dialer deployment work in a fresh context window.
> Master plan this serves: `/home/god0fm0ney/dev/Hermes_Dialer_System_Plan.md` (dialer = Phase 1 of the Hermes CRM).

## Where we are right now (the one-paragraph version)

The dialer is **deployed and live on Render** at https://rapiddial.onrender.com as a fully-armed
standby, but **Vonage webhooks still point at the operator's local cloudflared tunnel**, so all real
calling still happens from `localhost:3100`. The Render instance has an **empty database** and receives
**zero Vonage traffic** until the operator approves the webhook cutover. Nothing is broken; the local
line is untouched. Next steps are operator-gated decisions, not code.

## Live service facts

| Thing | Value |
|---|---|
| URL | https://rapiddial.onrender.com |
| Service ID | `srv-d8m37bmgvqtc73ck3lrg` (Oregon, Starter, node) |
| Disk | `dsk-d8m37bugvqtc73ck3me0`, 1 GB at `/var/data` (SQLite + recordings) |
| Repo / branch | `Growzilla/coldcaller` (private), branch **`deploy/render`** — auto-deploy ON |
| Build / start | `npm install --include=dev && npm run build` / `npm run start` |
| Health check | `/api/health` (public) |
| Render API key | `RENDER_API_KEY` in `/home/god0fm0ney/dev/.env` |

## Credentials (also set in Render env)

- Cockpit password (`DIALER_PASSWORD`): `NHZGdu0JiXxBJ2XMWZ5UuRmJYhdb`
- API bearer token (`DIALER_API_TOKEN`, what Hermes authenticates with): `d73bf2872e403db28ea7d249de29bced02456e4bd7c06897f9c0722da62268af`

## What was built (branch `deploy/render`, commits `d0f79a0` + `e8ec2ff`, on top of main `1be3de8`)

- `middleware.ts` — auth gate. Public: `/api/vonage/*`, `/api/health`, `/login`, `/api/login`, static.
  Bearer token for APIs, HMAC cookie for browser/SSE. **Fully disabled when `DIALER_PASSWORD` is unset**
  → local dev unchanged.
- `lib/auth.ts` — Web-Crypto HMAC cookie mint/verify (edge+node), 30-day expiry.
- `app/login/page.tsx` + `app/api/login/route.ts` — password → httpOnly secure cookie.
- `app/api/health/route.ts` — public `{ok:true}`.
- `lib/config.ts` — `DIALER_DATA_DIR` (default `./data`) roots dbPath + recordingsDir; `privateKey()`
  gains `VONAGE_PRIVATE_KEY_B64` fallback. Byte-identical locally with no env vars.
- `app/api/calls/[id]/audio/route.ts` — recordings dir from config, not hardcoded.
- `package.json` — start respects `$PORT`.

Earlier on main this session: **manual-dial feature** (`app/api/call/route.ts` accepts `{number}`,
cockpit input above lead card) — commit `1be3de8`, already on main + deployed.

## Verified working (production, 2026-06-13)

`/api/health` no-auth → 200 · cockpit no-cookie → 307 /login · `/api/state` no-token → 401 ·
`/api/state` with bearer → 200 JSON (proves creds + secret-file key + SQLite-on-disk all resolve) ·
`/api/vonage/*` public → 200.

## RESUME HERE — the three remaining steps, in order

### 1. Merge `deploy/render` → `main` (safe anytime, no operator risk)
PR: https://github.com/Growzilla/coldcaller/pull/new/deploy/render
The auth gate is dormant locally (no `DIALER_PASSWORD` set on the laptop), so merging does NOT change
the local dev workflow. After merge, consider repointing the Render service from `deploy/render` to
`main` (Render dashboard or API) so production tracks main, and delete the deploy branch.

### 2. Seed the production DB (operator sign-off — it's lead PII)
Production DB is empty (`queued: 0`). The local `data/dialer.db` has the live queue + call history.
Uploading it puts lead PII on Render's disk. When approved: copy `data/dialer.db` (and optionally
`data/recordings/`) to `/var/data/` on the service. NOTE: the safety hook blocks direct sqlite
bash writes/reads to `data/dialer.db` — move the file as an opaque blob, don't query it.

### 3. Vonage webhook cutover — ✅ DONE (S58, 2026-06-14, operator-approved)
Inbound + browser-leg traffic now hits the 24/7 Render box, not the laptop tunnel.
- **Executed:** `npx tsx scripts/set-webhooks.ts https://rapiddial.onrender.com` (new reusable
  script — flips Vonage answer/event webhooks to any https base; run with no arg to read current
  target). Previous target was a dead cloudflared tunnel
  (`library-mega-sustained-reservations.trycloudflare.com`).
- **Verified:** Vonage app now shows answer=`…/api/vonage/answer`, event=`…/api/vonage/event` on
  Render; a simulated inbound GET to the Render answer webhook returned HTTP 200 + a valid NCCO
  (the no-live-session "we'll call you back" talk action). Inbound is live on Render.
- **STILL UNVERIFIED — needs operator (browser + mic, can't do headless):** outbound browser-leg
  two-way audio FROM the Render cockpit. To confirm: open https://rapiddial.onrender.com, log in
  (`DIALER_PASSWORD`), Start line, confirm the `🔊✅ 🎤✅` chip. Only after that is the line fully
  trusted on Render. If it fails, flip back with
  `npx tsx scripts/set-webhooks.ts https://<a-fresh-tunnel>.trycloudflare.com` (or just run `coldcall`,
  which re-registers the tunnel).
- NOTE: running `coldcall` / `npm run tunnel` locally will RE-POINT webhooks back to the laptop
  tunnel (overwrites this cutover). Use `set-webhooks.ts` to flip back to Render afterward.
- Optional paid confirm: `scripts/solid-state-test.mjs` against prod ONCE (check balance first).

## Hard rules when working on this (learned the expensive way)

- **`scripts/solid-state-test.mjs` spends ~€1 of real Vonage credit per run and leaves a stuck session.**
  Run it AT MOST ONCE per change-set, check balance first, never A/B it with git-stash, never re-run to
  confirm a flaky T8/T9 (browser-audio tests are flaky independent of your change — the known
  unconfirmed-browser-connect issue). For code-only changes, `npx tsc --noEmit` + the operator's
  real-browser line-check is the verification. Deployment verification = HTTP/health only.
  (S53 mistake: ran it 3× and burned ~€3 the operator needed for calls.)
- Never touch Vonage webhook config without explicit operator approval — it kills whichever line is live.
- `NODE_ENV=production` on Render makes `npm install` skip devDeps → use `npm install --include=dev`.
- Edit, never Write, on existing files (safety hook blocks Write on existing files in this repo).

## After cutover — Phase 2 (next major chunk, see Hermes_Dialer_System_Plan.md §4)
Stand up the `hermes-crm-db` Postgres event ledger on Render; add a non-blocking dual-write
`lib/events.ts` to the dialer (SQLite stays source of truth; events fire-and-forget with an outbox
retry table). Hermes reads the ledger, writes interpretations. `POST /api/leads` (bearer-authed) lets
Hermes insert qualified scraped leads back into the dialer. Don't start this until steps 1–3 above land.
