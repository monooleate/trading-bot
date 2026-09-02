-- 006_blob_kv.sql — generic key/value store backing the Netlify Blobs compat
-- facade (packages/core/blobs-compat.ts) for the DURABLE non-session stores
-- (crypto-runtime, weather-runtime, momentum-snapshots, trade-log-v1,
-- scan-logs-v3, signal-combiner-v3, …). Session state uses the normalized
-- pillar_* tables (005); ephemeral *-cache stores live in-process. Value is the
-- exact string the bot wrote (JSON), so the port is byte-faithful. Idempotent.

CREATE TABLE IF NOT EXISTS blob_kv (
  store      TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT,
  metadata   JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (store, key)
);

DROP TRIGGER IF EXISTS trg_blob_kv_updated_at ON blob_kv;
CREATE TRIGGER trg_blob_kv_updated_at BEFORE UPDATE ON blob_kv
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
