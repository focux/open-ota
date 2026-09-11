-- The last checks a device made, so support can answer "why is this device not
-- getting the update" from what the server actually decided. A bounded ring
-- per client, pruned on write: this is a diagnostic tail, not a request log.
--
-- A device polls on a timer, so a run of identical answers is one entry with a
-- count rather than twenty rows saying the same thing. That keeps the ring
-- covering the transitions that explain the device instead of the last few
-- minutes of it repeating itself, and costs one statement per poll in the
-- steady state.
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
