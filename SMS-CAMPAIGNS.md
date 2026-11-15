# SMS campaigns

Small, paced cold SMS on the existing 46elks number. The cockpit is unchanged. Campaigns live at [http://localhost:3100/sms](http://localhost:3100/sms).

The worker sends at most one text per tick. Defaults: 50/day account cap, 90 seconds between sends, 09:00–17:00 Stockholm time, weekdays only. The gap cannot be set under 45 seconds. The daily limit cannot be set over `SMS_HARD_DAILY_CAP` (default 100, absolute max 200).

## Local

1. Credentials are the dialer's 46elks keys in `.env.local`: `46ELKS_API_USERNAME`, `46ELKS_API_PASSWORD`, `46ELKS_NUMBER`.
2. Optional campaign settings are in `.env.example` under `SMS_`. Copy the ones you want into `.env.local`.
3. Set `SMS_APP_PASSWORD` before the app is reachable from the internet.
4. Set `SMS_NOTIFY_NUMBER` to your mobile. Positive replies and inbound calls to the 46elks number text you.
5. Set `SMS_PUBLIC_URL` to the public origin once you have one. On localhost, delivery webhooks are skipped and messages stay at `sent`.

```bash
npm run dev          # cockpit + /sms on port 3100
npm run sms:worker   # separate process, one send per 30s when a campaign is running
npm run sms:test
```

Open `/sms`, import a CSV or add a lead, re-validate the number, confirm it when hitta.se does not show the full mobile, then start a campaign.

CSV columns it understands: `name`/`Namn`, `first_name`, `last_name`, `company`/`Företag`, `phone`/`Telefon`, `city`/`Stad`, `title`/`Titel`. Other columns are kept and can be used as `{Column}` variables and segment fields.

Template variables: `{Namn}`, `{Förnamn}`, `{Efternamn}`, `{Företag}`, `{Stad}`, `{Titel}`, `{Telefon}`. A send is skipped when a variable is empty.

## What gets sent

A number is eligible only when both are true:

- It is a Swedish mobile (`070`, `071`, `072`, `073`, `076`, `079`). Landlines, `010`, `020`, `075`, and `077` never send.
- hitta.se shows that person's full mobile, or you press **Confirm owner mobile** after checking the listing. A company listing needs **Confirm anyway**.

Leads marked in conversation, do not contact, or opted out are left out. `STOP`, `SLUTA`, `AVREGISTRERA`, and the other opt-out phrases suppress the number permanently.

Replies are classed with phrases: positive, negative, question, opt-out, other. A positive reply texts `SMS_NOTIFY_NUMBER` with the name, company, number, reply, reason, and a link to the thread.

**Dial** on a lead opens the cockpit with that number filled in. Start the line, then press Call number. `tel:` is next to it.

## Docker on a VPS

```bash
cp .env.example .env.local   # then fill in 46elks + SMS_ settings
docker compose up -d --build
```

The app and the worker share the `smsdata` volume (`/app/data/dialer.db`). Put the public URL in `SMS_PUBLIC_URL` so alert links and the delivery webhook resolve. Point the 46elks number's `sms_url` at `https://<host>/api/elks/sms?k=<token>` the same way the dialer tunnel does (`npm run elks-sms-setup`). The delivery callback is `/api/elks/sms/delivered` and is registered per message as `whendelivered`.

Inbound calls still follow the existing voice webhook. The added step only sends the operator SMS. It does not change how the call is connected.
