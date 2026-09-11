-- The last answers a device got, so support can say why it is not getting the
-- update. A bounded ring per client, pruned on write: a diagnostic tail, not a
-- request log. A run of identical answers is one row with a count, so the ring
-- holds the transitions rather than the last few minutes of polling.
CREATE TABLE device_checks (
  client_id TEXT NOT NULL,
  first_checked_at TEXT NOT NULL,
  last_checked_at TEXT NOT NULL,
  checks INTEGER NOT NULL DEFAULT 1,
  platform TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  channel TEXT NOT NULL,
  current_update_id TEXT,
  embedded_update_id TEXT,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  served_update_id TEXT,
  fatal_error TEXT
);

CREATE INDEX device_checks_device ON device_checks (client_id, last_checked_at DESC);
