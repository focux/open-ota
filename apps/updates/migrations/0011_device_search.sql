-- The device search reads by recency: newest check-ins first, optionally the
-- last N minutes, paged with a keyset on the same order. Without this it is a
-- full scan of the fleet plus a sort.
CREATE INDEX devices_seen ON devices (last_seen_at DESC, client_id DESC);

-- The runtime index gains the same ordering, so "which devices are still on
-- the old build" needs no sort. Its leading columns are unchanged, so the
-- aggregates keep using it. Nothing similar for platform or channel: both have
-- a handful of values fleet-wide, so they filter a recency scan rather than
-- lead it, and current_update_id and country already have their own.
DROP INDEX devices_runtime;
CREATE INDEX devices_runtime ON devices (platform, runtime_version, last_seen_at DESC);
