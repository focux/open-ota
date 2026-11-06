-- Fleet metrics must not fetch every device row to group its runtime or
-- update ids. Cover these reads, including country segments and rollbacks,
-- so repeated doctor checks stay within D1's resource window.
CREATE INDEX devices_metrics_runtime ON devices (channel, platform, runtime_version);
CREATE INDEX devices_metrics_current ON devices (current_update_id, channel, country);
CREATE INDEX devices_metrics_served ON devices (served_update_id, channel, current_update_id, embedded_update_id);
