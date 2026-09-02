CREATE TABLE device_update_failures (
  client_id TEXT NOT NULL,
  update_id TEXT NOT NULL,
  fatal_error TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (client_id, update_id)
);

CREATE INDEX device_update_failures_update ON device_update_failures (update_id);
