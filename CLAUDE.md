# Donyatt Flood Watch

A free community tool for drivers near Donyatt, Somerset, UK. The River Isle regularly floods:

- the **A358 south of Donyatt** (a main A303 diversion, ~12,700 vehicles/day),
- the **B3168 at Ilford Bridges**,
- the **Isle Brewers–Fivehead road**.

The tool combines Environment Agency (EA) river/rain data, a flood-likelihood prediction, and crowd road reports into a per-road recommendation: **Open / Caution / Avoid**.

## Stack

- Cloudflare Workers (TypeScript), Cron Triggers, D1 (SQLite), KV (cached status), R2 (photos), Turnstile (report spam protection), static assets served by the Worker (not Pages).
- Deploys via **Cloudflare Workers Builds** (the Cloudflare GitHub integration): Cloudflare builds the Worker `donyatt` on each push to `main` and runs `npm run deploy`, which applies D1 migrations and then runs `wrangler deploy`. No Cloudflare API token is stored in GitHub or in Claude sessions. GitHub Actions runs tests only (`.github/workflows/ci.yml`). Never commit secrets. The D1 database ID and KV namespace ID in `wrangler.toml` are not secrets, because they're useless without account access.
- The prediction model is trained in Python (in `/model`, run locally or by GitHub Actions), exported as JSON coefficients/thresholds, and evaluated in the Worker. No heavy ML at runtime.

## Data sources

- EA flood-monitoring API: `https://environment.data.gov.uk/flood-monitoring` (free, no key, ~15-min readings).
- River Isle level at the Donyatt gauge (public page: check-for-flooding.service.gov.uk/station/3076). Confirm the API station reference and measure ID from the API itself. Don't guess.
- Chard Snowden Hill rain gauge (upstream). Confirm its API measure ID.
- EA flood warning area `112FWFISL10A` (River Isle, Chard Reservoir to Hambridge).
- Forecast rainfall: Open-Meteo (free), added in a later stage.

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
  - a hold after the peak (A358 1 h, downstream roads 3 h).
- **Caution:**
  - level ≥ 1.20 m, or
  - level ≥ 1.00 m and rising ≥ 0.10 m/h, or
  - EA flood alert, or
  - ≥ 20 mm rain in 3 h / ≥ 35 mm in 12 h at Snowdon Hill, or
  - EA warnings not checked for 60 min, or
  - a hold (A358 1 h, downstream 6 h).
- **Unknown** (never Open) when the level reading is over 90 min old.
- The downstream roads (B3168 Ilford Bridges, Isle Brewers–Fivehead) have no published threshold. They use the Donyatt gauge with longer holds, as cautious defaults to tighten with local knowledge or reports.
- EA flood-warning times (`timeRaised` etc.) have no zone suffix. The page assumes UTC; this is unverified.

## Driver reports and learning data (Stage 3, text reports; photos in 3b)

- **Weighting** (`REPORTS` in `src/rules.ts`, logic in `src/reports.ts`): each report counts fully for 30 min, then fades to 0 at 3 h.
  - "Do not attempt" weight ≥ 0.5 means at least Caution; ≥ 1.5 means Avoid.
  - "Passable with care" weight ≥ 1 means Caution.
  - "Clear" never lowers anything; it's shown as information on Open or Caution roads.
  - Reports only ever make a status stricter.
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

### Report photos (Stage 3b; built, off until the R2 bucket exists)

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
  - A photo is shown only if approved in `/admin.html`, or corroborated by a same-kind report for the same road from another device within 60 min.
  - Never if hidden, rejected, or over 48 h old (`PHOTOS` in `src/rules.ts`).
  - Rejecting deletes the R2 object straight away.
- **Effect on status:** a report with a visible photo weighs ×1.5, so one "Do not attempt" with a checked photo means Avoid.
- **Cost guard:** 300 photos a day site-wide. After that, reports are still accepted, without photos.

## Product rules (non-negotiable)

- Never describe a road as "safe". Use Open / Caution / Avoid and "never drive into floodwater" messaging.
- Crowd reports (Clear / Passable with care / Do not attempt) lose weight with age, and every report shows its age.
- Reports can never downgrade the status below what an active EA warning or the gauge threshold implies.
- Photos: strip EXIF/location, resize, keep hidden until corroborated or approved, and auto-delete after 24–48 h via R2 lifecycle rules.
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
- No routes or custom domains on existing zones, and no DNS or zone changes of any kind. Deploy to the `workers.dev` subdomain only. `wrangler.toml` must contain no `routes` entries.
- If any command would affect an existing resource, stop and ask.

### Cloudflare resources (created by the owner in the dashboard, 2026-09-30)

| Resource | Name | Binding |
|---|---|---|
| Worker | `donyatt` (workers.dev only: donyatt.n2hfwbmyn9.workers.dev). The dashboard name wins, so `name` in `wrangler.toml` must match it. | — |
| D1 | `donyatt-db` | `DB` |
| KV | `donyatt-status` | `STATUS` |

## Repo layout and commands

- `src/`: the Worker.
  - `collector.ts` is the 15-minute cron job, `ea.ts` the EA API client and `config.ts` the EA IDs.
  - `rules.ts` holds the status thresholds and the road list, `status.ts` the pure Open/Caution/Avoid/Unknown logic, and `statusService.ts` loads from D1, caches in KV (`status:v1`) and runs the collector itself when the cron hasn't run for 20 minutes.
- `public/`: the static site.
  - `index.html`, `styles.css` and `app.js`: plain JS with no dependencies, rendering SVG charts by hand. Chart colours are level = blue, rain = aqua, checked with the dataviz palette validator. Status colours are reserved for Open/Caution/Avoid and always shown with an icon and label. Animations are off under `prefers-reduced-motion`.
  - `data/flood-history.json`: annual peaks and every ≥ 1.80 m event, regenerated with `python3 model/analyse_events.py --json public/data/flood-history.json`.
- Endpoints: `/api/config` (whether reports and photos are on, plus the Turnstile site key), `POST /api/reports` (JSON, or multipart with `photo`), `/api/photos/:id` (visible photos only), `/admin.html` with `/api/admin/reports` (moderation), `/` (page), `/api/status` (JSON, cached 60 s), `/api/history?days=1|2|7` (level and hourly rain for the charts, cached 5 min; tops up missing days from the EA once), `/health` (collector diagnostics). The cron also tops up history hourly via `fillHistory`, a no-op once 7 days are stored.
- `migrations/`: D1 schema (applied on deploy by `npm run deploy`).
- `test/`: Vitest tests. `fixtures/` holds real saved EA responses; files named `*synthetic*` are invented data in the EA shape. `d1-sqlite.ts` is a small D1 stand-in on Node's built-in SQLite. (`@cloudflare/vitest-pool-workers` currently fails to install with npm 10.)
- `model/`: Python. `backfill.py` downloads history into `model/data/` (git-ignored). `analyse_events.py` (needs `pip install -r model/requirements.txt`) regenerates `model/reports/flood_events.md`, the evidence behind the thresholds in `src/rules.ts`.
- `npm test`, `npm run typecheck`, `npm run dev` (then `curl "localhost:8787/__scheduled?cron=*/15+*+*+*+*"` to trigger the collector and `curl localhost:8787/health` to see the results). Run `npm run db:migrate:local` once first.
- `cd model && python3 -m unittest test_backfill`

## Working conventions

- Keep PRs small, and explain each one in plain English.
- Flag uncertainty rather than guessing (especially IDs, thresholds and anything safety-related).
