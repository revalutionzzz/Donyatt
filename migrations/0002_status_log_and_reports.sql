-- Status history and driver reports, kept indefinitely for learning (see CLAUDE.md).

-- What we showed for each road, when, and why. A 'change' row whenever a road's status
-- changes, plus an 'hourly' snapshot, so past calls can be scored against what happened.
CREATE TABLE status_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  road_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('change', 'hourly')),
  status TEXT NOT NULL,
  previous_status TEXT,
  at TEXT NOT NULL,
  level_m REAL,
  level_reading_at TEXT,
  rise_per_hour_m REAL,
  rain_3h_mm REAL,
  rain_12h_mm REAL,
  warnings TEXT,        -- JSON array of {floodAreaId, severityLevel}
  report_counts TEXT,   -- JSON {doNotAttempt, care, clear}: weighted recent reports
  reasons TEXT          -- JSON array of strings
);
CREATE INDEX status_log_road_at ON status_log (road_id, at);

-- Driver reports. Each one stores a snapshot of what we knew when it was made.
-- No IPs, names or locations: device_hash and ip_hash are HMACs with a key that
-- changes daily, so they work for rate limiting but can't track anyone across days.
CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  road_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('clear', 'care', 'do_not_attempt')),
  created_at TEXT NOT NULL,
  device_hash TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  status_shown TEXT,
  level_m REAL,
  level_reading_at TEXT,
  rise_per_hour_m REAL,
  rain_3h_mm REAL,
  ea_warning_level INTEGER,  -- most severe EA severity in force (1-3), NULL if none
  has_photo INTEGER NOT NULL DEFAULT 0,
  photo_state TEXT,          -- Stage 3b: 'pending' | 'approved' | 'rejected'
  hidden INTEGER NOT NULL DEFAULT 0,  -- removed by moderation; never counts
  hidden_reason TEXT
);
CREATE INDEX reports_road_created ON reports (road_id, created_at);
CREATE INDEX reports_device_created ON reports (device_hash, created_at);
CREATE INDEX reports_ip_created ON reports (ip_hash, created_at);
