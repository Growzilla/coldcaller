# RapidDial — Growzilla cold-calling cockpit

Single-operator power dialer. You answer one call at session start and stay on the line;
every lead is then bridged into your live call. Talk on your own phone — no headset, no WebRTC.

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
| `C` | Call current lead |
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
