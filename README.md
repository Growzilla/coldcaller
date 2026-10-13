# RapidDial — Growzilla cold-calling cockpit

Single-operator power dialer: a keyboard-driven cockpit that dials a lead queue one call at a
time, through your browser (mic + speakers) or your own phone. Providers: **Twilio** (any
country), **46elks** (Sweden), **Vonage** (legacy). Recording, AI call summaries and GoHighLevel
sync are optional.

## Quickstart (fork → calling in ~10 minutes)

Needs Node 20+, [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
(free quick tunnel for provider webhooks, no account) and `jq`.

```bash
git clone git@github.com:<you>/coldcaller.git && cd coldcaller
npm install
cp .env.example .env.local      # fill in ONE provider (Twilio is the easiest outside Sweden)
./coldcall                      # starts server + tunnel, reaps stale lines, opens http://localhost:3100
```

**Twilio setup**: in console.twilio.com copy the Account SID + Auth Token, buy/choose a voice
number (`TWILIO_NUMBER`), and create an API key (Account → API keys → Standard) for the browser
line. No TwiML App or webhook config needed. Each dial, Twilio rings your browser, the cockpit
answers it, and Twilio connects the lead.

Then in the cockpit: import leads (header button, any Apollo-style CSV, or `npm run import -- file.csv`)
→ **🎧 Start line (browser)** → allow the mic → wait for **✅ AUDIO VERIFIED** → press **P** to call,
**H** to hang up, **1–5** for the outcome, **Enter** for next. Only one call can be live at a time.

Optional: symlink `ln -s "$PWD/coldcall" ~/.local/bin/coldcall` to boot from anywhere. Set
`DIALER_PASSWORD` before exposing the app beyond localhost.

> The sections below describe the original Vonage phone-bridge setup and the 46elks/GHL
> workflow; `CLAUDE.md` holds the detailed operational notes.

## Architecture

```
 Your mobile (OPERATOR_PHONE)              Lead's phone
        ▲ leg A (answer once)                   ▲ leg B (per lead)
        │ from: +46790952801 (caller ID)        │ from: +46790952801
        └────────────┐            ┌─────────────┘
                  VONAGE ── named conversation per session ──
                     ▲ REST (JWT) + 1s status polling — NO webhooks/tunnel
                     ▼
              Next.js (localhost:3100) · SQLite · SSE → cockpit
```

## Setup (one-time)

1. Put credentials in `/home/god0fm0ney/dev/.env` (shared) or `.env.local` (this app):
   - `VONAGE_API_KEY` — 8-char key from dashboard.vonage.com → API settings
   - `VONAGE_API_SECRET` — the secret next to it
2. `npm run setup` — verifies creds, creates the Voice application
   (`secrets/private.key`), confirms the LVN, writes `VONAGE_APPLICATION_ID` to `.env.local`.
3. Add `OPERATOR_PHONE=+467XXXXXXXX` (your mobile, E.164) to `.env.local`.
4. `npm run test-call` — rings your phone; add a second number to test the full bridge:
   `npm run test-call -- +46XXXXXXXXX`

## Daily use

```bash
npm run dev          # cockpit at http://localhost:3100
npm run import       # (re)import Sweden ecom CSVs + call-log callbacks — idempotent
npm run export-log   # append today's outcomes to growzillaAssets CALL-LOG-YYYY-MM-DD.md
```

In the cockpit: **Start line** → answer your phone once → you're live for the whole session.

| Key | Action |
|-----|--------|
| `P` | Call current lead (one call at a time) |
| `H` | Hang up lead (you stay on the line) |
| `1–5` | Outcome: no answer / callback / interested / not interested / bad number |
| `Enter` | Save outcome + next lead |
| `S` | Skip lead |
| `U` | Undo last wrapup |
| `B` | Email the lead your booking link (Resend, mid-call) |
| `O` / `L` | Open website / LinkedIn |
| `N` | Focus notes |

## Call intelligence (browser-line sessions)

Every answered call is recorded in the browser (mic + remote mixed), uploaded on hangup,
transcribed (Whisper) and analyzed (GPT): summary, action items, interest 1–5, objections.
Intel appears in the cockpit ~20s after each call. `npm run digest` writes the full session
digest (aggregated action items + transcripts) to `growzillaAssets/sales/leads/DIGEST-*.md`.
Booked-meeting detection activates when `CALENDLY_TOKEN` is set in `.env.local`.
Browser line needs `npm run tunnel` running (self-configures Vonage webhooks).

Import any Apollo-style CSV via the header button (schema auto-detected) or
`npm run import -- path/to/file.csv`.

## Data

SQLite at `data/dialer.db` — tables `leads`, `calls`, `sessions`.
Queue order: priority 0 (callbacks due, parsed from CALL-LOG markdown) → 1 (high-value) → 2.

## Compliance (Sweden)

B2B cold calling is permitted. NIX-Telefon covers consumers — skip obvious sole traders
(enskild firma) or check nixtelefon.org. Lawful basis: legitimate interest (B2B outreach).
No call recording (keeps GDPR surface minimal).

## Cost

Two concurrent legs ≈ €0.04–0.08/min total to Swedish mobiles. Balance shows in the header;
calls are blocked under €1.

## GoHighLevel sync (`lib/ghl.ts`)

GHL is the lead master. `coldcall` pulls your open opportunities in **New Lead / Attempted /
Callback** into the queue (callbacks first; anything dialed < 20 h ago stays out). Every wrapup
pushes back: contact upsert, stage move (never backward), `cc-*` tag, call note, and the AI
summary as a follow-up note. Calendly bookings → **Meeting Booked**. Sync is off until the token
is set, and a GHL outage never blocks dialing (failures → `calls.ghl_error`, retry with `resync`).

| Wrapup | GHL |
|---|---|
| 1 no answer | → Attempted |
| 2 callback | → Callback |
| 3 interested | → Interested |
| 4 not interested | status Lost |
| 5 bad number | status Lost |
| Calendly booking | → Meeting Booked |

One-time setup:
1. GHL → Opportunities → Pipelines: create **Outbound** with stages named exactly
   `New Lead`, `Attempted`, `Callback`, `Interested`, `Meeting Booked` (add later stages freely).
2. GHL sub-account → Settings → Private Integrations → new token, scopes: contacts (read/write),
   opportunities (read/write), locations (read).
3. `.env.local`: `GHL_PRIVATE_TOKEN=…`, `GHL_LOCATION_ID=…`, `GHL_USER_ID=…` (your GHL user —
   each cofounder's dialer sets their own), optional `GHL_PIPELINE_NAME` (default `Outbound`).
4. `npm run ghl -- check` → then migrate the local list once: `npm run ghl -- push --limit 1000`.

Commands: `npm run ghl -- check | pull | push [--limit N] [--source FILE] | resync`.
