# Donyatt Flood Watch

A free community tool for drivers near Donyatt, Somerset. It combines Environment Agency river and rain data with road reports to give an **Open / Caution / Avoid** recommendation for the roads the River Isle floods. Never drive into floodwater.

Project brief and rules: [CLAUDE.md](CLAUDE.md).

## Status

- Stage 1 (collector): a Cloudflare Worker that stores the Donyatt river level, Chard Snowdon Hill rainfall and EA flood warnings every 15 minutes. `GET /health` shows the latest collected data.
- Stage 2 (status): Open / Caution / Avoid for each road at `/`, JSON at `/api/status`. The rules are in `src/rules.ts`, with the evidence in `model/reports/flood_events.md`.
- Site: live status cards, an animated river gauge, 24 h / 48 h / 7 day level and rain charts, and a chart of every flood since the 1990s.
- Stage 3 (reports, text): drivers report Clear / Passable with care / Do not attempt. Reports fade over 3 hours, only ever make a road stricter, and are kept anonymously with a snapshot for learning. They're switched off until the Turnstile keys are set.
- Stage 3b (photos): an optional photo with a report. Location data is stripped, and the photo is hidden until checked or confirmed, then deleted after 2 days. Switched off until the R2 bucket exists.
- Stage 4 (alerts): a Telegram channel post when a road's status changes. Escalations are sent at once; easing waits 30 minutes to avoid flapping. Switched off until the bot secrets are set.
- Stage 5 (forecast and outlook): an hourly Open-Meteo rain forecast, and a model trained on EA records giving the chance Donyatt reaches road-flooding level within 3 and 6 hours. An Elevated or High outlook puts roads on Caution. See `model/reports/model_card.md`.
