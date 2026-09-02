-- 003_prediction_ledger.sql — the unbiased point-in-time forecast dataset
-- (model-discovery §2). 1:1 port of the Blobs ledger record; UPSERT per
-- (category, slug). Matches hetzner-docker-setup.md §8. Idempotent.

CREATE TABLE IF NOT EXISTS prediction_ledger (
  id               BIGSERIAL PRIMARY KEY,
  category         TEXT NOT NULL,               -- crypto|weather|hyperliquid
  slug             TEXT NOT NULL,               -- market slug or coin
  condition_id     TEXT,
  end_date         TIMESTAMPTZ,
  first_ts         TIMESTAMPTZ NOT NULL,
  ts               TIMESTAMPTZ NOT NULL,        -- latest prediction
  predicted_prob   NUMERIC NOT NULL,            -- model P(YES)
  market_price     NUMERIC,
  edge             NUMERIC,
  direction        TEXT,
  taken            BOOLEAN NOT NULL DEFAULT false,
  last_action      TEXT,
  skip_reason      TEXT,
  signal_breakdown JSONB,
  scans            INT NOT NULL DEFAULT 1,
  outcome          NUMERIC,                     -- YES-resolution 0/1, NULL while unresolved
  resolved_at      TIMESTAMPTZ,
  UNIQUE (category, slug)                       -- upsert-per-market (Blobs 1:1)
);

CREATE INDEX IF NOT EXISTS idx_pl_cat_resolved ON prediction_ledger(category, outcome);
CREATE INDEX IF NOT EXISTS idx_pl_pending ON prediction_ledger(category) WHERE outcome IS NULL;
