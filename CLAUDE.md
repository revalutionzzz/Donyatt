# Donyatt Flood Watch

A free community tool for drivers near Donyatt, Somerset, UK. The River Isle regularly floods:

- the **A358 south of Donyatt** (a main A303 diversion, ~12,700 vehicles/day),
- the **B3168 at Ilford Bridges**,
- the **Isle Brewers–Fivehead road**.

The tool combines Environment Agency (EA) river/rain data, a flood-likelihood prediction, and crowd road reports into a per-road recommendation: **Open / Caution / Avoid**.

## Stack

- Cloudflare Workers (TypeScript), Cron Triggers, D1 (SQLite), KV (cached status), R2 (photos), Turnstile (report spam protection), static assets served by the Worker (not Pages).
- Deploys via GitHub Actions using secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Never commit secrets or IDs that belong in secrets.
- The prediction model is trained in Python (in `/model`, run locally or by GitHub Actions), exported as JSON coefficients/thresholds, and evaluated in the Worker. No heavy ML at runtime.

## Data sources

- EA flood-monitoring API: `https://environment.data.gov.uk/flood-monitoring` (free, no key, ~15-min readings).
- River Isle level at the Donyatt gauge (public page: check-for-flooding.service.gov.uk/station/3076). Confirm the API station reference and measure ID from the API itself. Don't guess.
- Chard Snowden Hill rain gauge (upstream). Confirm its API measure ID.
- EA flood warning area `112FWFISL10A` (River Isle, Chard Reservoir to Hambridge).
- Forecast rainfall: Open-Meteo (free), added in a later stage.

### Confirmed IDs

_Not yet confirmed. Fill this in (with the date and the API URL used) once they have been checked against a live API response._

| What | Station reference | Measure ID | Confirmed on |
|---|---|---|---|
| Donyatt river level | TBC | TBC | — |
| Chard Snowden Hill rainfall | TBC | TBC | — |

## Known Donyatt gauge thresholds (from the EA)

| Level | Meaning |
|---|---|
| 1.20 m | Top of normal range |
| 1.40 m | Low-lying land flooding possible |
| 1.80 m | Historical road flooding at Donyatt |
| 2.03 m | Property flooding possible / flood warning threshold |
| 2.63 m | Highest recorded (31 Dec 2000) |

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

## Working conventions

- Keep PRs small, and explain each one in plain English.
- Flag uncertainty rather than guessing (especially IDs, thresholds and anything safety-related).
