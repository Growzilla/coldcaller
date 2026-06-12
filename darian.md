# Darian — RapidDial setup (Canada)

> **STATUS: PAUSED** — nothing below is live yet. Before this works, Albert needs to:
> 1. Buy a Canadian Vonage number (dashboard → Numbers → Buy → Canada + Voice, ~€1/mo)
> 2. Push this repo to private GitHub and invite you
> 3. Send you the two API credentials privately (NOT in the repo)

## What this is

A power dialer: you answer ONE call on your cell at session start and stay on the line.
Then every lead you call gets bridged into your live call instantly — no redialing, no
ringing your phone per lead. A web cockpit shows the company, their website, notes, and
one-key outcome logging. Receiving the call on your cell is free; all per-minute cost is
billed to the Vonage account.

## Setup (~10 min, needs Node 20+)

```bash
git clone <repo-url> && cd coldcaller
npm install
```

Create `.env.local` in the project root:

```
VONAGE_API_KEY=<from Albert>
VONAGE_API_SECRET=<from Albert>
VONAGE_NUMBER=+1XXXXXXXXXX      # the Canadian number Albert bought — your caller ID
OPERATOR_PHONE=+1XXXXXXXXXX     # YOUR cell — rings once per session
```

Then:

```bash
npm run setup       # verifies creds, creates your own voice app, links the CAD number
npm run test-call   # your cell rings, you hear "Dialer connected" — pipes proven
npm run import -- path/to/your-leads.csv   # Apollo-style CSV, schema auto-detected
npm run dev         # cockpit at http://localhost:3100
```

## Daily flow

1. **Start line** → answer your cell once → leave the call running
2. `C` = call lead · talk · `H` = hang up (you stay on the line)
3. `1–5` = outcome (no answer / callback / interested / not interested / bad number)
4. Type a note, `Enter` = save + next lead. `S` skip, `U` undo.
5. **End line** when done. `npm run export-log` writes a markdown summary of the session.

Use the country dropdown in the header to filter the queue (e.g. just Canada).

## Rules of the road 🇨🇦

- **Businesses only.** Canada's National Do-Not-Call List covers consumers; B2B calls are
  exempt. Stick to business numbers.
- Your caller ID is the Canadian Vonage number. Brand-new VoIP numbers can show
  "Likely Spam" on some carriers for the first week or two — normal human-paced calling
  (which is all this dialer does) clears it.
- Calls cost the shared Vonage balance ~$0.02–0.05 CAD/min for both legs combined.
  Balance shows in the cockpit header; calling blocks under €1.

## If something breaks

- "Missing VONAGE_*" banner → `.env.local` incomplete, or rerun `npm run setup`
- Phone doesn't ring on Start line → check `OPERATOR_PHONE` is E.164 (`+1` prefix, no spaces)
- Lead numbers failing instantly → bad CSV phone format; the importer drops undialable rows,
  check the import summary
- Anything else → tell Albert, his AI built it and can fix it remotely
