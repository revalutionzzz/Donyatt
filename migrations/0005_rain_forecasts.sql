-- Open-Meteo hourly rain forecasts for Chard. Every fetch is kept, so forecasts can later be
-- scored against the rain that actually fell at the Snowdon Hill gauge (and used for training).
CREATE TABLE rain_forecasts (
  fetched_at TEXT NOT NULL,
  hour_end TEXT NOT NULL,   -- forecast hour (UTC); mm is the rain in the hour ending here
  mm REAL NOT NULL,
  PRIMARY KEY (fetched_at, hour_end)
) WITHOUT ROWID;
CREATE INDEX rain_forecasts_hour ON rain_forecasts (hour_end);
