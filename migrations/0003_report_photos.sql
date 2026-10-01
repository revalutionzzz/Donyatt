-- Stage 3b: optional photo with a report. The image lives in R2 (donyatt-photos), deleted after
-- 2 days by the bucket's lifecycle rule; only its key and moderation state are kept here.
ALTER TABLE reports ADD COLUMN photo_key TEXT;
CREATE INDEX reports_photo ON reports (has_photo, created_at);
