# RapidDial (coldcaller) — CLAUDE.md

Single-operator browser power dialer on Vonage. Cockpit at `localhost:3100` (`npm run dev`),
browser-line calling needs `npm run tunnel` (quick tunnel + auto-registers Vonage webhooks).
DB: SQLite `data/dialer.db` (`leads`, `calls`, `sessions`, `meta`).

## Clean startup — ALWAYS boot via `coldcall`

```bash
coldcall          # runnable from anywhere (~/.local/bin/coldcall → repo ./coldcall)
```
One command, guaranteed-clean state. It: (1) starts the server if down, (2) (re)starts the
tunnel only if dead/unregistered — a running cloudflared PID is NOT proof, it auto-updates and
silently exits, so the script requires the "Vonage app webhooks" log line, (3) **reaps any
zombie session via `POST /api/session/end`** — THIS is the clean-slate guarantee that prevents
the dead-air bug, (4) prints balance + queue, (5) opens the cockpit. Don't hand-start `npm run
dev`/`tunnel` for a calling session — use `coldcall` so the zombie reap always happens.

## Voice I/O — the mistakes that caused silent calls (don't repeat)

Every "I can't hear the prospect / they can't hear me" came from a layer lying about audio.
The short ledger (details in the sections below):

- **Recorder captured only my mic, not the prospect** — scraped `<audio>` elements at
  record-start; the SDK swaps `srcObject` so the reference went stale. FIX: tap the raw
  `RTCPeerConnection` track events at the source (`window.__rtcRemoteTracks`). Don't ever go
  back to scraping `<audio>` for the remote leg.
- **Dead-air after a page reload** — reload destroyed the browser's WebRTC media but the DB
  said "live"; the cockpit trusted the DB and dialed into an empty room. FIX: green dot now
  means VERIFIED audio (auto line-check), + reload-orphan reaper + `coldcall` zombie reap.
  Never treat a session row as proof of audio.
- **Transcription silently 401'd** — `OPENAI_API_KEY` was dead, so every "prospect audio"
  transcript came back empty and looked like the recording failed. FIX: OpenRouter Gemini.
- **Self-test calls misread as inbound prospects** — the line-check leg (our LVN → our LVN)
  collided with the inbound-caller discriminator. FIX: self-leg is its own webhook branch that
  joins the room but never creates call rows / touches `leg_a_uuid`.

Verify both directions are actually flowing before trusting it: the cockpit's `🔊✅ 🎤✅` chip
(auto after line start) or `node scripts/solid-state-test.mjs` (paid — see warning below).

## THE PRIME DIRECTIVE: audio is verified, never assumed

The green dot means **verified two-way audio**, not "DB session row says live".
Every regression in this app's history was some layer silently lying about audio:

- **2026-06-12 dead-air incident**: page reload destroyed the WebRTC media but left the DB
  session "live" and a zombie leg "answered" at Vonage for HOURS. Cockpit showed "Line live",
  operator dialed, room was empty → silence both ways. NEVER trust session state as audio state.
- **Two-rooms race (S45)**: browser leg and server legs each lazily creating `dialer-room-N`
  produced TWO conversations with the same name → no shared audio. Fix: `ensureConversation()`
  pre-creates the room; ALL server legs must use the SAME regional host as the Client SDK
  (`https://api-us-3.vonage.com`, pinned in `lib/config.ts` `vonageApiHost`).
- **One-sided recordings**: scraping `<audio>` elements at record-start broke when the SDK
  swapped `srcObject`. Recorder now taps raw `RTCPeerConnection` track events
  (`window.__rtcRemoteTracks`, late tracks via `window.__recorderAddTrack`).

### Solid-state mechanisms (do not remove, they back each other up)
1. **RTCPeerConnection patch** (`page.tsx ensureRemoteAudioPlayback`): MUST run before the SDK
   builds its PC. Pipes every remote audio track into `#rtc-remote-audio`, stashes tracks +
   pcs + connectionState on `window`.
2. **Auto line check** (`runLineCheck` in page.tsx + `POST /api/line-check` + `runLineCheck()`
   in lib/vonage.ts): after the line goes live, the server dials our own LVN into the room and
   speaks TTS; the browser asserts it HEARS it (remote RMS > 5) and that the mic SENDS
   (outbound-rtp bytesSent +10kB). Chip in header: `🔊✅ 🎤✅`. Re-run via "↻ audio" button.
   Never runs during an active call.
3. **Reload-orphan reaper** (page.tsx): an active rtc session observed within 15s of page load
   that this page doesn't own = corpse from previous load → auto-ended. The 15s window is
   load-bearing: without it, an idle second tab/test harness war would reap live sessions.
4. **Late-zombie retry** (startLineRtc): "Session already active" → end + retry once.
5. **Media liveness watcher**: `connectionstatechange` → failed/closed ⇒ red LINE DEAD banner.

## Answer webhook: THREE leg types (app/api/vonage/answer/route.ts)

Discrimination order matters; all three NCCO into the same room:
1. **Self leg** — `from` AND `to` ∈ our LVNs (`CALLER_IDS` in lib/config.ts): line-check/harness.
   Joins room, must NOT touch `leg_a_uuid` or create call rows.
2. **Inbound prospect** — `to` ∈ our LVNs, `from` = other digits: match `leads.phone_e164`,
   INSERT call row (captures missed calls), publish SSE `inbound` {from, lead, stats} → cockpit
   banner + lead-card swap. No live session → polite TTS, call row still captured.
3. **Browser leg** — anything else (Client SDK serverCall): joins room + `markSessionLive(uuid)`.

## Verification — run after ANY change to audio, webhook, session, or recorder code

```bash
node scripts/solid-state-test.mjs   # 10 tests, all must pass → 🟢 GREENLIGHT
```
T1 state · T2 public webhook (reads answer_url from Vonage app config, probes it) · T3 JWT ·
T4 room pre-created on region host (409-probe) · T5 browser-leg routing · T6 inbound routing +
SSE · T7 self-leg isolation · T8 headless cockpit HEARS the check leg · T9 mic bytesSent grows ·
T10 recording upload → OpenRouter transcript + analysis. No human phones ring (self-LVN legs
only); costs a few cents of Vonage credit. Older focused harness: `scripts/audio-bridge-harness.mjs`.

## Dead-air triage (operator says "I can't hear them / they can't hear me")

1. Cockpit header chip: `🔊❌` or `🎤❌`? → click "↻ audio" to re-check. LINE DEAD banner? →
   End line + Start line.
2. `node scripts/solid-state-test.mjs` — pinpoints the broken layer in ~3 min.
3. Tunnel: cloudflared AUTO-UPDATES and exits (killed the line 2026-06-11). Check
   `pgrep -f cloudflared`; restart `npm run tunnel` (re-registers webhooks at the NEW
   trycloudflare URL — old URL is dead forever).
4. Did the operator reload the page? Reaper should handle it; verify session table has no
   stuck `live` rtc rows: `SELECT * FROM sessions WHERE status IN ('starting','live')`.
5. Region: every server-created leg must go through `getVonage()` (pinned host). A leg created
   on `api.nexmo.com` lands in a DIFFERENT room with the same name.

## Call intelligence

`OPENAI_API_KEY` in `/dev/.env` is DEAD (401, 2026-06-12). The pipeline uses
`OPENROUTER_API_KEY` (lib/config.ts `openrouterApiKey`): transcription =
`google/gemini-2.5-flash` with base64 `input_audio` format `webm` (accepts the recorder's
opus/webm DIRECTLY, no conversion); analysis = `openai/gpt-4o-mini` JSON mode. OpenRouter is
Cloudflare-fronted → browser-ish User-Agent or 403 (CF 1010).

## Facts that keep biting

- `/dev/...` in conversation = `/home/god0fm0ney/dev/...` on disk. Never bash `/dev/`.
- `/home/god0fm0ney/dev/.env` cannot be bash-`source`d (unquoted `)` in a secret). Extract:
  `grep '^KEY=' file | cut -d= -f2-`.
- Vonage Voice REST wants digits-only E.164 (no `+`). DB stores `+`-prefixed.
- DTMF: keyboard digits send tones ONLY while a call is answered; outcome keys 1–5 own
  wrapup after hangup. `POST /api/dtmf` → `playDTMF` on the lead leg.
- Test call (`/api/test-call`) defaults to the operator's REAL phone (+66838840280) — the
  harness/suite overrides `number` with the LVN so nothing rings.
- `--target N` in the sweden_leads pipeline = TOTAL ledger size, not net-new.
- Caller ID auto-picks by lead country (US/CA → +12088587571, else +46790952801),
  override via header toggle. Both numbers are in `OWN_NUMBERS` for webhook discrimination.
- Recordings: browser MediaRecorder webm/opus, mic + remote mixed. GDPR note in README says
  "no call recording" — recording IS enabled now; update README if compliance posture matters.
- cloudflared quick tunnels: new URL every restart; `npm run tunnel` handles re-registration.
  The dev log lives at /tmp/coldcaller-dev.log, tunnel log at /tmp/coldcaller-tunnel.log.

## Editing rules for this repo

- Read before editing; Edit (not Write) on existing files.
- After touching `app/api/vonage/*`, `lib/vonage.ts`, `lib/recorder.ts`, `lib/rtc.ts`, or the
  RTC parts of `page.tsx`: run the solid-state suite BEFORE telling the operator it works.
- The cockpit tab holds live WebRTC state — code changes hot-reload the page and can kill the
  browser leg. After shipping changes mid-session, tell the operator: End line → reload → Start
  line (the reaper + auto-check make this safe now).

## ⚠️ The solid-state suite SPENDS REAL VONAGE CREDIT (S53 lesson, 2026-06-13)

`scripts/solid-state-test.mjs` creates real Vonage legs (self-LVN calls + line-check leg + an intel
recording). **Each full run ≈ €1 and leaves a stuck `live`/`starting` session row.** It is a one-shot
pre-flight, NOT a debug loop.

- **Check balance FIRST** (`/api/state` returns it) and run it **AT MOST ONCE** per change-set.
- **NEVER A/B it** with `git stash`, and **never re-run to confirm a flaky result.** T8/T9 (browser
  audio assertions) are flaky independent of your change — that's the known unconfirmed-browser-connect
  issue, not your code. Reason about it; don't burn credit re-running.
- **For code-only changes** (dial routing, UI, API shape): `npx tsc --noEmit` + the operator's
  real-browser line-check is the verification. Don't reach for the paid suite.
- **After any run**, clear the stuck session: `POST /api/session/end`, then confirm no `live`/`starting`
  rows remain.
- (S53 mistake: ran it 3× — initial + a stash A/B + a retry — and drained €5.87→€2.81 right when the
  operator needed credit to make calls. Don't repeat this.)

## Render deployment (rapiddial — S53, 2026-06-13)

- Deployed live at https://rapiddial.onrender.com (`srv-d8m37bmgvqtc73ck3lrg`), branch `deploy/render`.
  **Full handoff + resume steps: `DEPLOYMENT-HANDOFF.md` in this repo.** Read it before any deploy work.
- `NODE_ENV=production` makes Render's `npm install` skip devDependencies (tailwind/typescript are
  devDeps and needed at build) → build command MUST be `npm install --include=dev && npm run build`.
- Private key → Render **secret file** at `/etc/secrets/private.key` (never commit, never plain env);
  point at it via `VONAGE_PRIVATE_KEY_PATH`. `config.privateKey()` also has a `VONAGE_PRIVATE_KEY_B64`
  fallback.
- Auth gate (`middleware.ts`) is **disabled when `DIALER_PASSWORD` is unset**, so local dev is unchanged.
- **NEVER repoint Vonage webhooks without explicit operator approval** — it kills whichever line is
  currently live (local tunnel today). Webhook cutover is an operator-gated, between-call-blocks step.

## 46elks live line + GHL queue (2026-10-12)

`coldcall` now boots **46elks** by default (`COLDCALL_PROVIDER=vonage coldcall` to switch back; Vonage
creds 401 since 2026-10-07) and opens the cockpit at `?provider=46elks&source=ghl`.

- **Browser line = a separate 46elks WebRTC number**, not +46766861525 (that PSTN number can't do WebRTC).
  `lib/elks-rtc.ts discoverWebrtcNumber()` finds it on the account (capability `webrtc`) and uses its digits as
  SIP user + its `secret` as password. Allocate with `npm run elks:webrtc -- --allocate` (30 SEK/month). Verified
  API quirk: for `country=se` ONLY `capabilities=webrtc` is accepted; `voice,webrtc` or any `category` → 403.
- Each lead dial = 46elks calls the WebRTC client (browser auto-answers, 0 öre) → `connect` to the lead with
  caller ID +46766861525 (0.57 SEK/min to SE mobiles). Every call is its OWN peer connection that closes on
  hangup, so LINE DEAD for 46elks = JsSIP not registered (or the live leg's pc failed), not `pc closed`.
- Line check (rtc): server calls our WebRTC number and plays `LINE_CHECK_CLIP` twice; cockpit lazily attaches its
  analyser + max-samples bytesSent during the check. `files.46elks.com/examples/hello.mp3` is 404 — never use it.
- Self-test: Start line (browser) → ✅ audio → type the operator mobile in "Dial any number" → ☎ Call number.
  Calls to the operator's own number never sync to GHL (`syncCall` guard).
- **GHL queue**: token from `~/.config/ghl/anvil_systems_pit` (or `GHL_PRIVATE_TOKEN`), location/user default to
  Anvil Systems / Albert. Pull → priority 1 (callbacks 0), `leads.score` = ICP tier from tags, then the exact
  ICP Score custom field via `/contacts/search` (`enrichScores`). Queue order: `priority, score DESC, id`.
  `nix-required` (sole traders) → `status='nix_hold'` until NIX-washed (`GHL_INCLUDE_NIX=1` to dial them).
  The GHL client retries 429s — bulk imports share the 100 req/10 s location limit.
