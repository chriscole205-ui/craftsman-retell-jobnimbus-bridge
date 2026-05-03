# Retell AI → JobNimbus bridge

This service listens for Retell `call_analyzed` webhooks, creates a new lead in JobNimbus, and schedules a callback task in the next open slot on the chosen JobNimbus schedule.

## What it does

- verifies the Retell webhook signature
- reads structured post-call analysis fields from Retell
- creates a JobNimbus contact lead
- optionally creates a JobNimbus job record
- finds the next open callback slot by scanning existing JobNimbus tasks
- creates a callback task tied to the new lead
- uses `external_id` values so webhook retries do not duplicate records

## Retell setup

1. In Retell, configure the agent to collect the intake fields listed in `retell-post-call-analysis.example.json`.
2. Enable the `call_analyzed` webhook event for the agent or phone number.
3. Point the webhook to `https://YOUR-DOMAIN/webhooks/retell`.
4. Keep the API key used by this bridge in `RETELL_API_KEY`; the bridge uses it to verify the `X-Retell-Signature` header.

Retell signs each webhook request with `X-Retell-Signature`, retries failed webhook deliveries up to 3 times, and `call_analyzed` includes the structured `call_analysis` object after the call ends. Only answered calls get post-call analysis output.

## JobNimbus setup

1. Create a JobNimbus API key and place it in `JOBNIMBUS_API_KEY`.
2. Confirm the record type and status names you actually use for new leads.
3. Set `JOBNIMBUS_TASK_OWNER_IDS` and `JOBNIMBUS_SCHEDULE_OWNER_IDS` to the JobNimbus owner IDs that should receive and be considered for callback scheduling.
4. Adjust workday hours and slot length if your schedule uses something other than 8 AM–5 PM in 60-minute blocks.

By default this bridge uses the legacy public API base URL `https://app.jobnimbus.com/api1`, which is the endpoint documented in the JobNimbus public API reference. If your account is mapped differently, override `JOBNIMBUS_BASE_URL`.

## Environment

Copy `.env.example` to `.env` and fill in the values.

## Run locally

```bash
cd integrations/retell-jobnimbus
cp .env.example .env
npm install
npm start
```

The service listens on `PORT` and exposes:

- `GET /health`
- `POST /webhooks/retell`

## Deployment notes

Any always-on Node host works. A ready-to-use `render.yaml` and `Dockerfile` are included for a Render deployment. Once deployed, paste the public webhook URL into Retell.

## Assumptions you should review

- A new lead should be created as a JobNimbus contact with status `New`.
- The callback task should be scheduled against the earliest open slot across the configured JobNimbus owner calendars.
- Existing scheduled JobNimbus tasks represent blocked time on those calendars.
- If no free slot exists inside the lookahead window, the webhook returns an error so Retell retries instead of silently dropping the lead.
