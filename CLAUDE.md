# Donyatt Flood Watch

A free community tool for drivers near Donyatt, Somerset, UK. The River Isle regularly floods the **A358 south of Donyatt** (a main A303 diversion, ~12,700 vehicles/day).

The tool combines Environment Agency (EA) river/rain data, a flood-likelihood prediction, and crowd road reports into a recommendation for the A358: **Open / Caution / Avoid**.

The site covers the A358 only. The B3168 at Ilford Bridges and the Isle Brewers–Fivehead road were in the original brief, but they were dropped on 2026-10-01 at the owner's request: they have no published threshold or nearby gauge, so their statuses were guesses. Old `status_log` rows and reports for them (`b3168-ilford-bridges`, `isle-brewers-fivehead`) are kept. The code still handles a list of roads (`ROADS` in `src/rules.ts`), so a road can be added back if there's evidence for a threshold.

## Stack

- Cloudflare Workers (TypeScript), Cron Triggers, D1 (SQLite), KV (cached status), R2 (photos), Turnstile (report spam protection), static assets served by the Worker (not Pages).
- Deploys via **Cloudflare Workers Builds** (the Cloudflare GitHub integration): Cloudflare builds the Worker `donyatt` on each push to `main` and runs `npm run deploy`, which applies D1 migrations and then runs `wrangler deploy`. No Cloudflare API token is stored in GitHub or in Claude sessions. GitHub Actions runs tests only (`.github/workflows/ci.yml`). Never commit secrets. The D1 database ID and KV namespace ID in `wrangler.toml` are not secrets, because they're useless without account access.
- The prediction model is trained in Python (in `/model`, run locally or by GitHub Actions), exported as JSON coefficients/thresholds, and evaluated in the Worker. No heavy ML at runtime.

## Data sources

- EA flood-monitoring API: `https://environment.data.gov.uk/flood-monitoring` (free, no key, ~15-min readings).
- River Isle level at the Donyatt gauge (public page: check-for-flooding.service.gov.uk/station/3076). Confirm the API station reference and measure ID from the API itself. Don't guess.
- Chard Snowden Hill rain gauge (upstream). Confirm its API measure ID.
- EA flood warning area `112FWFISL10A` (River Isle, Chard Reservoir to Hambridge).
- Forecast rainfall: Open-Meteo (free, no key), fetched hourly for the Chard gauge location. See Stage 5 below.

### Confirmed IDs

Checked against the live EA APIs on 2026-09-30.

| What | Flood-monitoring station | Live measure (flood-monitoring API) | Hydrology API station (for backfill) |
|---|---|---|---|
| Donyatt river level (River Isle) | `52115` (RLOI `3076`, WISKI `520190_FW`) | `52115-level-stage-i-15_min-mASD` | `6d2349f9-d71e-45a9-ba86-0bafdab39c35`, measure `…-level-i-900-m-qualified` |
| Chard Snowden Hill rainfall | `52129` (ST310089) | `52129-rainfall-tipping_bucket_raingauge-t-15_min-mm` | `d1803c5a-e461-404b-8750-7f946456a6c6`, measures `…-rainfall-t-900-mm-qualified` (15 min), `…-rainfall-t-86400-mm-qualified` (daily) |
| Flood warning area | `112FWFISL10A` | Active warnings: `/id/floods` filtered on `floodAreaID` | — |

Notes:

- **Use the `mASD` Donyatt measure.** The station also lists `52115-level-stage-i-15_min-m`, but that one stopped updating on 2026-06-16. `mASD` (metres above stage datum) is on the same scale as the thresholds below: the stage scale (`/id/stations/52115/stageScale`) gives the typical range as 0.124–1.2 m, the max on record as 2.632 m (2000-12-31) and the highest recent as 2.42 m (2013-12-24). If readings stop, check the station's `measures` list again rather than assuming the ID is permanent.
- The flood-monitoring API labels rain gauges only as "Rainfall station". The name comes from the hydrology API, which labels `52129` as "Chards Snowdon Hill" (spelled *Snowdon*), open since 2017-03-29. Rainfall history before 2017 needs a different gauge.
- **The Hydrology API Donyatt series changes datum.** Until 2026-09-16 07:15Z it is in metres above Ordnance Datum (stage + 35 m, the `datum` in the stage scale). After that it is in stage metres. There is also a stray `0.0` at 2026-08-19 15:45Z. `model/backfill.py` converts everything to stage metres and keeps the raw value. The live flood-monitoring `mASD` measure is already in stage metres.
- Hydrology API timestamps have no `Z` suffix but are UTC (they match the flood-monitoring API reading for reading).
- Parent flood **alert** area for `112FWFISL10A` is `112WAFTSSR` ("South Somerset Rivers, Upper Reaches"). The collector records both.
- The flood area's official label is "River Isle from Chard Reservoir to Hambridge not including Ilminster".

## Known Donyatt gauge thresholds (from the EA)

| Level | Meaning |
|---|---|
| 1.20 m | Top of normal range |
| 1.40 m | Low-lying land flooding possible |
| 1.80 m | Historical road flooding at Donyatt |
| 2.03 m | Property flooding possible / flood warning threshold |
| 2.63 m | Highest recorded (31 Dec 2000), per the EA stage scale. **Out of date:** the EA archive has higher readings graded "Good", 2.65 m on 2021-10-20 and **2.68 m on 2025-01-26**. The site takes the record from `public/data/flood-history.json`. |

## Stage 2 status rules (see `src/rules.ts` and `model/reports/flood_events.md`)

- The river is flashy. Across 56 floods since 1992 it took a median of 1.0 h (shortest 12 min) from 1.40 m to 1.80 m, and live EA readings arrive 15-45 min late.
- **Avoid:**
  - EA flood warning or severe flood warning in force, or
  - level ≥ 1.80 m, or
  - level ≥ 1.50 m and projected to reach 1.80 m within 1 h plus the reading's age, or
  - a hold of 1 h after the peak.
- **Caution:**
  - level ≥ 1.20 m, or
  - level ≥ 1.00 m and rising ≥ 0.10 m/h, or
  - EA flood alert, or
  - ≥ 20 mm rain in 3 h / ≥ 35 mm in 12 h at Snowdon Hill, or
  - EA warnings not checked for 60 min, or
  - a hold of 1 h.
- **Unknown** (never Open) when the level reading is over 90 min old.
- EA flood-warning times (`timeRaised` etc.) have no zone suffix. The page assumes UTC; this is unverified.

## Driver reports and learning data (Stage 3, text reports; photos in 3b)

- **Weighting** (`REPORTS` in `src/rules.ts`, logic in `src/reports.ts`): each report counts fully for 30 min, then fades to 0 at 3 h.
  - "Do not attempt" weight ≥ 0.5 means at least Caution; ≥ 1.5 means Avoid.
  - "Passable with care" weight ≥ 1 means Caution.
  - "Clear" never lowers anything; it's shown as information on Open or Caution roads.
  - Reports only ever make a status stricter.
  - **One device, one voice** (since 2026-10-02): only each device's newest live report counts (by the daily `device_hash`), so one person can't reach Avoid by reporting twice 10 min apart. Avoid from reports needs two devices (or one admin-approved photo).
  - **Unconfirmed reports** (since 2026-10-02, owner's request): when the river, rain and EA data alone say Open, a status raised by reports from a single device is marked `unconfirmed` on the road ("Not yet confirmed by the river data or another driver."). It shows on the site but is **not announced on Telegram**: `processAlerts` skips it and leaves the alert state alone, so it's announced once a second device or the data backs it, and clears silently if not.
  - On the page, "Passable with care" and "Do not attempt" ask "Are you sure?" only when the river is in its normal range (< 1.20 m), where the report would be the only sign of trouble.
- **`POST /api/reports`** (`src/reportsApi.ts`):
  - Turnstile is verified server-side, with the visitor IP sent to siteverify.
  - Rate limits: 1 per road per device per 10 min, 6 per device per day, 20 per network address per day.
  - Each report stores a snapshot of what we knew (status shown, level, rate of rise, 3 h rain, worst EA warning).
- **Privacy:** no IPs, names or locations are stored.
  - `device_hash` and `ip_hash` are HMACs with a random daily key held in KV (`salt:YYYY-MM-DD`, 3-day TTL). They work for same-day rate limits but can't link anyone across days.
  - The page footer explains this. Keep it accurate if anything changes.
- **Switching reports on:**
  - Reports are off (button hidden, API returns 503) until both `TURNSTILE_SITE_KEY` (`[vars]` in `wrangler.toml`, public) and the `TURNSTILE_SECRET_KEY` Worker secret are set.
  - Moderation (`/admin.html`, `/api/admin/reports`) is off until the `ADMIN_TOKEN` Worker secret is set.
  - Set secrets in the dashboard as type **Secret**: plain dashboard variables are wiped by the next deploy.
- **Learning data, kept indefinitely:**
  - `status_log` has a row whenever a road's status changes, plus hourly snapshots, each with the inputs and reasons.
  - `reports` keeps every report, including moderated ones (`hidden = 1`, never counted).
  - Use both to tune per-road thresholds and hold times, and to score past calls. Learning may only **suggest** threshold changes; a human approves them in a PR.
- Gotcha: a DOM element with `id="turnstile"` shadows `window.turnstile`. The widget container is `#turnstile-box`.

### Report photos (Stage 3b; on since 2026-10-01)

- **Switching on:**
  1. Create the R2 bucket `donyatt-photos` with a lifecycle rule deleting objects after 2 days.
  2. Uncomment the `[[r2_buckets]]` block in `wrangler.toml`. A binding to a bucket that doesn't exist breaks deploys, so don't uncomment it early.
  3. `/api/config` then reports `photosEnabled`.
- **On the phone:** the page decodes the photo, scales it to ≤ 1600 px and re-encodes it as JPEG through a canvas, which drops EXIF/GPS.
- **On the server** (`src/jpeg.ts`): it doesn't trust the client.
  - Rejects anything that isn't a JPEG, or is over 1.5 MB or 2048 px.
  - Strips APP1–APP15 and COM segments (EXIF, GPS, XMP, ICC, comments).
  - Stores the result at `reports/<id>-<uuid>.jpg`.
- **Visibility** (`VISIBLE_PHOTO_SQL` in `src/reports.ts`, used for both serving and status):
  - Since 2026-10-02, at the owner's request, photos are shown **straight away** with the report. The owner didn't want to approve photos by hand. (Before that, a photo needed admin approval or a same-kind report from another device within 60 min.)
  - Never shown if the report is hidden, the photo rejected, or over 48 h old (`PHOTOS` in `src/rules.ts`).
  - Moderation is after the fact: hide the report or reject the photo in `/admin.html`. Rejecting deletes the R2 object straight away.
  - The page footer asks people not to photograph people or number plates.
- **Effect on status:** only a photo the admin **approved** weighs ×1.5 (one "Do not attempt" with an approved photo means Avoid). Unapproved photos are shown but add no weight, so one person can't push the status alone with a photo.
- **Cost guard:** 300 photos a day site-wide. After that, reports are still accepted, without photos.

## Telegram alerts (Stage 4; on since 2026-10-01, test alert confirmed)

- **Switching on:** add Worker secrets `TELEGRAM_BOT_TOKEN` (from @BotFather) and `TELEGRAM_CHAT_ID` (e.g. `@channelname` for a public channel with the bot as admin). Check them with "Send test alert" on `/admin.html` (`POST /api/admin/alerts/test`).
- **Where it runs** (`src/alerts.ts`): `processAlerts` runs inside `refreshStatus` after the status log, so a change from any path (cron, request backstop, report, moderation) is announced straight away. Alert failures never block the status.
- **When it sends:**
  - Escalations (to Caution or Avoid) go out at once, except an `unconfirmed` one (a single driver's report with the data showing nothing), which waits for confirmation (see Driver reports).
  - Easing, and Unknown, go out only after holding for `ALERTS.holdMinutes` (30), so a river hovering at a threshold doesn't spam people.
  - The first run after switch-on records statuses silently.
  - Several roads changing together go out as one message.
- **EA alerts and warnings** (since 2026-10-02): a flood alert, flood warning or severe flood warning for `112FWFISL10A` or `112WAFTSSR` is announced when issued, upgraded, downgraded or removed, even if the road's status doesn't change. It's combined into the same message as any road change; an EA-only message also lists each road's current status. Last announced EA state is in KV (`alerts:ea:v1`); the first run, and any run before the EA has been checked, records silently.
- **State:** the last announced status per road is kept in KV (`alerts:state:v1`). A failed send leaves it unchanged, so the next refresh retries.
- **Record:** every attempt goes into `alerts_sent`.
- **Message text:** HTML-escaped, always ends with "Never drive into floodwater" and the site link, and never says "safe".
- **On the page:** the "Stay up to date" panel links the channel. `/api/config` gives `telegramUrl`, derived from `TELEGRAM_CHAT_ID` only when it is a public `@username` (a numeric private chat ID is never exposed), or from an optional `TELEGRAM_CHANNEL_URL` `[vars]` entry (`https://t.me/...` only). With neither, the Telegram block is hidden.

## Rain forecast and flood outlook (Stage 5)

- **Forecast** (`src/forecast.ts`):
  - Open-Meteo `/v1/forecast` for the Chard Snowdon Hill gauge location: `hourly=precipitation,precipitation_probability`, `timezone=GMT`, 24 h. Each value is the rain in the hour ending at that time, plus the % chance of more than 0.1 mm (`rain_forecasts.probability`, migration 0007; null for older fetches).
  - Amounts come in 0.1 mm steps, so a dry spell is all zeros. The page shows the chance of rain only when the forecast amount is dry: the amount and the chance come from different Open-Meteo models and can disagree (e.g. 1.4 mm beside 2%).
  - Fetched at most hourly (self-throttled via D1) from the cron, the collector backstop, `/health` and `/api/history` (when there's no fresh forecast), so the chart doesn't depend on the cron. After a failure it retries at most every 10 min.
  - Every attempt is logged in `forecast_attempts`, and `/health` shows `forecast` (latest fetch, age, last attempt and Open-Meteo's error reason).
  - Every fetch is kept in `rain_forecasts`, so forecasts can be scored against the gauge later.
  - Confirmed working against the live API on 2026-10-01 (the Worker stores forecasts). The test fixture is still synthetic, shaped from the docs, because the sandbox can't reach Open-Meteo.
- **Model** (`model/train.py`, exported to `src/model/flood-model.json`, evaluated by `src/predict.ts`):
  - Logistic regression for P(Donyatt ≥ 1.80 m within 3 h / 6 h), hourly samples below 1.80 m.
  - Features: level, rise over 1 h / 3 h, log1p of Chard rain over 1/3/6/24/72 h, and (forecast variant) log1p of forecast rain over the next 6 h.
  - Trained 2017–2022, tested 2023–2026; see `model/reports/model_card.md`. On 11 unseen test floods the 10% threshold flagged all of them, with median notice about 2.5 h (vs 1.5 h for the rules) and about 7 false-alarm days a year.
  - The forecast variant was trained with the rain that actually fell (a perfect-forecast upper bound).
- **Live use:**
  - Features are taken as of the latest time *both* feeds have reported (rain often lags the river by a reading). There's no outlook if rain lags by more than 60 min, any rain window is under 95% complete, or the river data is stale. Missing rain would understate the risk.
  - The forecast variant is used when a forecast under 3 h old covers the next 6 h; otherwise the nowcast.
  - p6h is max(p6h, p3h), because the models are fitted separately.
- **Effect on status:** an Elevated (≥ 10%) or High (≥ 40%) 6 h outlook adds a Caution reason to every road. The model never lowers a status and never sets Avoid.
- **Retraining:** run `pip install -r model/requirements.txt`, then `python3 model/backfill.py`, then `python3 model/train.py`. This regenerates the JSON, the model card and `test/fixtures/model-parity.json`, and the parity test checks the TypeScript matches. If the test-period results change, update the "How the outlook works" text in `public/index.html`.

## Product rules (non-negotiable)

- Never describe a road as "safe". Use Open / Caution / Avoid and "never drive into floodwater" messaging.
- Crowd reports (Clear / Passable with care / Do not attempt) lose weight with age, and every report shows its age.
- Reports can never downgrade the status below what an active EA warning or the gauge threshold implies.
- Photos: strip EXIF/location, resize, and auto-delete after 24–48 h via R2 lifecycle rules. (Originally "keep hidden until corroborated or approved"; the owner chose on 2026-10-02 to show them straight away, with after-the-fact moderation and no extra status weight unless approved.)
- Rate-limit reports per device. Turnstile on all submissions.

## Build stages (one PR each, in order)

1. **Collector**: a cron Worker (every 15 min) that stores the Donyatt level, Snowden Hill rainfall and active EA warnings in D1. Plus a one-off backfill script for historical readings (EA archive/hydrology data) for model training.
2. **Status**: rule-based Open/Caution/Avoid per road, cached in KV, served as JSON plus a simple mobile-first page.
3. **Reports**: report form with Turnstile, report weighting/decay, optional photo upload to R2.
4. **Alerts**: a Telegram bot that posts on status changes (bot token via secret).
5. **Model**: Python training on gauge + rainfall history (+ reports as ground truth over time), exported to JSON, used for "likely in the next 3–6 h" predictions.

## Cloudflare safety rules (the account already hosts other live sites)

- **Before creating anything**, do a read-only inventory with Wrangler/the API: list existing Workers, D1 databases, KV namespaces and R2 buckets. Report what exists and the names you plan to use (all prefixed `donyatt-`), and confirm there are no clashes.
- **Then stop and wait for explicit approval** before creating any resources.
- Only create new resources prefixed `donyatt-`. Never modify, redeploy, rename or delete anything that already exists.
- Claude never makes DNS, zone, route or custom-domain changes. `wrangler.toml` must contain no `routes` entries.
- The only custom domain is **donyattfloodwatch.co.uk** (plus `www.`), a zone the owner registered for this site and attached to the `donyatt` Worker in the dashboard on 2026-10-01. No other domain or zone may be attached to this Worker, and nothing on the owner's other zones may point at it. The `workers.dev` address stays on as a fallback.
- If any command would affect an existing resource, stop and ask.

### Cloudflare resources (created by the owner in the dashboard, 2026-09-30)

| Resource | Name | Binding |
|---|---|---|
| Worker | `donyatt` at **https://donyattfloodwatch.co.uk/** (custom domain, set in the dashboard), also donyatt.n2hfwbmyn9.workers.dev. The dashboard name wins, so `name` in `wrangler.toml` must match it. `SITE_URL` in `src/config.ts` (used in Telegram alerts) and the canonical/Open Graph tags in `index.html` use the custom domain. | — |
| D1 | `donyatt-db` | `DB` |
| KV | `donyatt-status` | `STATUS` |
| R2 | `donyatt-photos` (lifecycle: delete after 2 days; public access off) | `PHOTOS` |
| Turnstile | widget `donyatt-reports`, site key in `wrangler.toml` `[vars]`. Its hostname list must include every address the site is served on, or reports fail there. | — |
| Telegram channel | https://t.me/donyattfloodwatch (`TELEGRAM_CHANNEL_URL` in `[vars]`) | — |
| Worker secrets | `TURNSTILE_SECRET_KEY`, `ADMIN_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (set by the owner, 2026-10-01) | — |

## Repo layout and commands

- `src/`: the Worker.
  - `collector.ts` is the cron job (every 5 min since 2026-10-02, so each 15-min EA reading reaches the site sooner), `ea.ts` the EA API client and `config.ts` the EA IDs.
  - `rules.ts` holds the status thresholds and the road list, `status.ts` the pure Open/Caution/Avoid/Unknown logic, and `statusService.ts` loads from D1, caches in KV (`status:v2`; bump the key when the report shape or road list changes) and runs the collector itself when the cron hasn't run for 20 minutes.
- `public/`: the static site.
  - `index.html`, `styles.css` and `app.js`: plain JS with no dependencies, rendering SVG charts by hand. Chart colours are level = blue, rain = aqua, checked with the dataviz palette validator. Status colours are reserved for Open/Caution/Avoid and always shown with an icon and label. Animations are off under `prefers-reduced-motion`.
  - Motion: the river gauge (`renderTank` in `app.js`) is a small simulation. A spring eases the water level and a damped oscillator makes the surface slosh, with two travelling ripples on top. It gets kicked by level changes and taps, and shows bubbles while rising. On phones it uses the motion sensors: `deviceorientation` sets the resting tilt so the surface stays level with the world (adjusted for screen rotation, capped at 35°), and `devicemotion` shakes push the slosh. iOS needs `DeviceOrientationEvent.requestPermission()`, which is only ever called from a tap on the gauge; Android needs no prompt. Sensors are ignored under reduced motion. 0 m sits a little above the tube's rounded bottom (`TANK.floor`), so a normal low river still shows water; faint 1 m and 2 m ticks give a scale, and "Last 24 h" low–high sits under the reading. It runs on `requestAnimationFrame` only while on screen and the tab is visible, and draws one still frame under reduced motion. Road cards update in place, so status colours can transition. Panels reveal on scroll via a position check, not IntersectionObserver alone, so a fast scroll can't leave one hidden.
  - Logo: `icons/icon.svg`, a church tower on the hill above the River Isle and a flood depth post (the tower is a generic drawing, not traced from St Mary's). `node scripts/render-icons.cjs` (needs Playwright) renders the PNG icons, `avatar-512.png` (round, with the name, for the Telegram channel) and `social-card.png` (link previews). The page header shows the logo next to the name; the app icon has no text, because it is unreadable at small sizes.
  - Installable web app: `manifest.webmanifest`, icons in `icons/` (rendered from `icons/icon.svg`), and `sw.js`. The service worker never caches the status or any data. It only caches `offline.html`, which says the status can't be shown and repeats "never drive into floodwater". The page uses the browser's install prompt where there is one (Android, desktop Chrome/Edge) and shows Share → Add to Home Screen steps on iOS. A banner offers it after 15 s, on phones only and from the second visit (visits counted per browser session in `localStorage`). Dismissing it hides it for 30 days. Never shown when already installed, and the body gets bottom padding while it shows so the footer stays visible.
  - Status at a glance: the header tints amber/red for Caution/Avoid (`.hero[data-status]`, always with the icon and words). The road card says "No driver reports in the last 3 hours" when there are none. The outlook shows clock times ("by 16:40") measured from the reading it used. When the river is ≥ 1.0 m and rising, the river panel says when it would reach 1.80 m at the current rate (within 12 h), always "at this rate" and "could be sooner". There's no scroll fade-in on panels: on a safety tool everything is visible at once. Past-floods bars: flood years (≥ 1.80 m) full blue, other years `--series-level-soft` (status colours stay reserved for the live status). One explanation of how it works, in the footer (`#how`, `#how-outlook`). On desktop, `.grid-2` stacks the river card and the EA warnings on the left with the chart spanning both on the right (grid areas), so there's no gap under the short river card; phones keep river, chart, warnings.
  - Home-screen name is "Donyatt Flood Watch" (`short_name` in the manifest and `apple-mobile-web-app-title`); iOS may shorten it under the icon.
  - Search engines: `robots.txt` (blocks only admin) and `sitemap.xml` (the home page). Every element showing live status (summary, road card, outlook, river and chart panels, warnings) has `data-nosnippet`, so Google never quotes a stale "A358 open" in search results; keep it on anything new that shows live status. The owner submits the sitemap in Google Search Console.
  - Live updates: the page checks `/api/status` every minute and reloads the charts as soon as the status shows a newer river reading (or every 5 min). Both fetches use `cache: "no-store"`. It catches up on `visibilitychange`, `focus`, `online` and `pageshow` (phones pause timers in the background), and "x min ago" texts tick every 30 s.
  - `data/flood-history.json`: annual peaks and every ≥ 1.80 m event, regenerated with `python3 model/analyse_events.py --json public/data/flood-history.json`.
- Endpoints: `/api/config` (whether reports and photos are on, plus the Turnstile site key), `POST /api/reports` (JSON, or multipart with `photo`), `/api/photos/:id` (visible photos only), `/admin.html` with `/api/admin/reports` (moderation), `/` (page), `/api/status` (JSON, cached 60 s), `/api/history?days=1|2|7` (level, hourly rain and the next 12 h of forecast rain for the charts, cached 1 min; tops up missing days from the EA once), `/health` (collector diagnostics). The cron also tops up history hourly via `fillHistory`, a no-op once 7 days are stored.
- `migrations/`: D1 schema (applied on deploy by `npm run deploy`).
- `test/`: Vitest tests. `fixtures/` holds real saved EA responses; files named `*synthetic*` are invented data in the EA shape. `d1-sqlite.ts` is a small D1 stand-in on Node's built-in SQLite. (`@cloudflare/vitest-pool-workers` currently fails to install with npm 10.)
- `model/`: Python. `train.py` trains the flood-outlook model (see Stage 5 above). `backfill.py` downloads history into `model/data/` (git-ignored). `analyse_events.py` (needs `pip install -r model/requirements.txt`) regenerates `model/reports/flood_events.md`, the evidence behind the thresholds in `src/rules.ts`.
- `npm test`, `npm run typecheck`, `npm run dev` (then `curl "localhost:8787/__scheduled?cron=*/15+*+*+*+*"` to trigger the collector and `curl localhost:8787/health` to see the results). Run `npm run db:migrate:local` once first.
- `cd model && python3 -m unittest test_backfill`

## Working conventions

- Keep PRs small, and explain each one in plain English.
- Flag uncertainty rather than guessing (especially IDs, thresholds and anything safety-related).
