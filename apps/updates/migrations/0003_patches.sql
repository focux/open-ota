CREATE TABLE patches (
  base_hash TEXT NOT NULL,
  target_hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (base_hash, target_hash)
);
