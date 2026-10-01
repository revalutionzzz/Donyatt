-- Every Open-Meteo fetch attempt, so /health can show why the forecast is missing
-- (and failed attempts are retried at most every few minutes).
CREATE TABLE forecast_attempts (
  attempted_at TEXT PRIMARY KEY,
  ok INTEGER NOT NULL,      -- 1 if hours were stored
  hours INTEGER NOT NULL,   -- forecast hours stored
  error TEXT                -- why it failed, including Open-Meteo's own reason when it gives one
) WITHOUT ROWID;
