# RapidDial (coldcaller) — CLAUDE.md

Single-operator browser power dialer on Vonage. Cockpit at `localhost:3100` (`npm run dev`),
browser-line calling needs `npm run tunnel` (quick tunnel + auto-registers Vonage webhooks).
DB: SQLite `data/dialer.db` (`leads`, `calls`, `sessions`, `meta`).

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
