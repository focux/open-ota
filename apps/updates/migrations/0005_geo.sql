ALTER TABLE devices ADD COLUMN country TEXT;
ALTER TABLE devices ADD COLUMN city TEXT;
CREATE INDEX devices_country ON devices (country);
