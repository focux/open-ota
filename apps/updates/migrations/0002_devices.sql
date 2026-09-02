CREATE TABLE devices (
  client_id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  channel TEXT NOT NULL,
  current_update_id TEXT,
  embedded_update_id TEXT,
  served_update_id TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX devices_runtime ON devices (platform, runtime_version);
CREATE INDEX devices_current ON devices (current_update_id);
CREATE INDEX devices_served ON devices (served_update_id);
