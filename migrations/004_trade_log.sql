-- 004_trade_log.sql — structured event log (the Blobs trade-log-v1 + logger
-- LogEntry). Append-only; one row per event. Idempotent.

CREATE TABLE IF NOT EXISTS trade_log (
  id       BIGSERIAL PRIMARY KEY,
  ts       TIMESTAMPTZ NOT NULL DEFAULT now(),
  category TEXT,
  event    TEXT NOT NULL,
  paper    BOOLEAN,
  payload  JSONB
);

CREATE INDEX IF NOT EXISTS idx_trade_log_cat_ts ON trade_log(category, ts DESC);
CREATE INDEX IF NOT EXISTS idx_trade_log_event ON trade_log(event);
