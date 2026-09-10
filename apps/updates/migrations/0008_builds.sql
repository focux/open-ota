CREATE TABLE builds (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  runtime_version TEXT NOT NULL,
  profile TEXT NOT NULL,
  distribution TEXT NOT NULL CHECK (distribution IN ('store', 'internal', 'simulator')),
  channel TEXT,
  embedded_update_id TEXT NOT NULL UNIQUE,
  launch_asset_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO builds (
  id, platform, runtime_version, profile, distribution, embedded_update_id, launch_asset_hash, created_at
)
SELECT
  update_id, platform, runtime_version, 'production', 'store', update_id, launch_asset_hash, created_at
FROM embedded_updates;

DROP INDEX embedded_updates_runtime;
DROP TABLE embedded_updates;

CREATE INDEX builds_lookup
  ON builds (platform, runtime_version, profile, distribution, channel, created_at DESC);
