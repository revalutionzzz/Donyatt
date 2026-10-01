-- Stage 4: every Telegram alert we tried to send, for the record.
CREATE TABLE alerts_sent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  roads TEXT NOT NULL,   -- JSON [{roadId, from, to}]
  text TEXT NOT NULL,
  ok INTEGER NOT NULL,
  error TEXT
);
CREATE INDEX alerts_sent_at ON alerts_sent (at);
