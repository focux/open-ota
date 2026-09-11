-- The last checks a device made, so support can answer "why is this device not
-- getting the update" from what the server actually decided. A bounded ring
-- per client, pruned on write: this is a diagnostic tail, not a request log.
CREATE TABLE device_checks (
  client_id TEXT NOT NULL,
  checked_at TEXT NOT NULL,
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

CREATE INDEX device_checks_device ON device_checks (client_id, checked_at DESC);
