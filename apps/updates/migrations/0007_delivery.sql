-- The size a bundle really costs over the wire: Cloudflare compresses
-- compressible content types at the edge, so a patch competes with this.
ALTER TABLE assets ADD COLUMN compressed_size INTEGER;
-- Last time a publish asked whether the asset was already present. A sweep
-- leaves recently touched assets alone so an in-flight publish can reference them.
ALTER TABLE assets ADD COLUMN touched_at TEXT;
-- Stamped when a sweep deleted the update's bundle. Such an update can no
-- longer be rolled back to.
ALTER TABLE updates ADD COLUMN pruned_at TEXT;

-- The JS baked into a store build. Registered so a fresh install, whose
-- current update is the embedded one, can be served a patch too.
CREATE TABLE embedded_updates (
  update_id TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  runtime_version TEXT NOT NULL,
  launch_asset_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX embedded_updates_runtime ON embedded_updates (platform, runtime_version);
