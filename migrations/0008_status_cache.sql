-- The latest computed status, served to visitors. It's rewritten every 5 minutes, which is too
-- many writes for KV's free plan (1,000 a day); D1 allows 100,000.
CREATE TABLE status_cache (
  key TEXT PRIMARY KEY,      -- e.g. "status:v3"; bump the version when the report shape changes
  generated_at TEXT NOT NULL,
  report TEXT NOT NULL       -- JSON StatusReport
) WITHOUT ROWID;
