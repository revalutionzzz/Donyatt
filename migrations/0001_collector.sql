-- Stage 1: raw EA data collected every 15 minutes.

-- One row per EA reading. ts is the EA dateTime (ISO 8601, UTC, "Z").
CREATE TABLE readings (
  measure_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (measure_id, ts)
) WITHOUT ROWID;

-- One row per version of an EA flood alert/warning message for the areas we
-- watch. last_seen_at is the started_at of the latest run whose /id/floods
-- fetch included it, so "currently active" = rows whose last_seen_at equals
-- the latest run with warnings_ok = 1.
CREATE TABLE flood_warnings (
  flood_area_id TEXT NOT NULL,
  time_message_changed TEXT NOT NULL,
  severity_level INTEGER NOT NULL,
  severity TEXT NOT NULL,
  message TEXT,
  time_raised TEXT,
  time_severity_changed TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (flood_area_id, time_message_changed)
);
CREATE INDEX flood_warnings_last_seen ON flood_warnings (last_seen_at);

-- One row per cron run, so later stages can tell stale data from "no warnings".
CREATE TABLE collector_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  level_ok INTEGER NOT NULL,
  rain_ok INTEGER NOT NULL,
  warnings_ok INTEGER NOT NULL,
  readings_inserted INTEGER NOT NULL,
  warnings_seen INTEGER NOT NULL,
  errors TEXT
);
CREATE INDEX collector_runs_started ON collector_runs (started_at);
