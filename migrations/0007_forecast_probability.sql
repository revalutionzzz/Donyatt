-- Open-Meteo's chance of rain (> 0.1 mm) in each forecast hour, 0-100. Null for older fetches,
-- or hours the forecast model doesn't cover.
ALTER TABLE rain_forecasts ADD COLUMN probability INTEGER;
