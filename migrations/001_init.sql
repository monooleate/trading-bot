-- 001_init.sql — shared primitives. Idempotent.
-- The migrate runner owns schema_migrations; this file adds the shared
-- updated_at trigger helper used by later migrations.

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
