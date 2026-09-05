CREATE TABLE branches (
  name TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE channels (
  name TEXT PRIMARY KEY,
  branch_name TEXT NOT NULL REFERENCES branches(name),
  updated_at TEXT NOT NULL
);

CREATE TABLE update_groups (
  id TEXT PRIMARY KEY,
  branch_name TEXT NOT NULL REFERENCES branches(name),
  message TEXT,
  git_commit TEXT,
  created_at TEXT NOT NULL,
  published_at TEXT
);

CREATE TABLE updates (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES update_groups(id),
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  runtime_version TEXT NOT NULL,
  launch_asset TEXT,
  assets TEXT,
  expo_config TEXT,
  rollout_percent INTEGER NOT NULL DEFAULT 100,
  rollback_to_embedded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX updates_selection ON updates (platform, runtime_version, created_at DESC);
CREATE INDEX updates_group ON updates (group_id);

CREATE TABLE assets (
  hash TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO branches (name, created_at) VALUES ('staging', '2026-09-02T00:00:00.000Z'), ('production', '2026-09-02T00:00:00.000Z');
INSERT INTO channels (name, branch_name, updated_at) VALUES ('staging', 'staging', '2026-09-02T00:00:00.000Z'), ('production', 'production', '2026-09-02T00:00:00.000Z');
