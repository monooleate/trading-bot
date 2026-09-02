-- 005_pillar_state.sql — NORMALIZED per-pillar session state (runbook §11.1
-- decision: normalized, not blob-model). The Blobs session object is split
-- into three tables: one session row per pillar, and first-class rows for open
-- positions and closed trades (queryable/indexable per category+date). Only
-- irreducibly document-shaped context (entryDecision, signalBreakdown,
-- weatherMeta, bot-specific scalars) lives in JSONB `payload`/`extra`.
-- Idempotent.

-- One row per pillar (crypto|weather|hyperliquid|funding-arb|sports).
CREATE TABLE IF NOT EXISTS pillar_session (
  category           TEXT PRIMARY KEY,
  started_at         TIMESTAMPTZ NOT NULL,
  bankroll_start     NUMERIC NOT NULL,
  bankroll_current   NUMERIC NOT NULL,
  session_pnl        NUMERIC NOT NULL DEFAULT 0,
  session_loss       NUMERIC NOT NULL DEFAULT 0,   -- absolute sum of losing trades
  trade_count        INT NOT NULL DEFAULT 0,
  paper_mode         BOOLEAN NOT NULL DEFAULT true,
  stopped            BOOLEAN NOT NULL DEFAULT false,
  stopped_reason     TEXT,
  sim_version        INT,
  -- Bot-specific session scalars (HL consecutiveLosses/pausedUntil, weather
  -- calibrationAlertSentAt, arb/sports specifics) ride in `extra` so each
  -- pillar round-trips exactly its own keys (no cross-pillar column pollution).
  extra              JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_pillar_session_updated_at ON pillar_session;
CREATE TRIGGER trg_pillar_session_updated_at BEFORE UPDATE ON pillar_session
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Open positions — replaced-per-save within a category (mirrors the Blobs
-- whole-session rewrite). Common scalars are columns; rich nested context
-- (buyOrderId, clobTokenIds, entryDecision, signalBreakdown, weatherMeta,
-- HL leverage, …) rides in `payload`.
CREATE TABLE IF NOT EXISTS pillar_open_position (
  id                    BIGSERIAL PRIMARY KEY,
  category              TEXT NOT NULL,
  seq                   INT NOT NULL DEFAULT 0,     -- preserve array order
  market                TEXT NOT NULL,
  token_id              TEXT,
  direction             TEXT,
  shares                NUMERIC,
  avg_entry             NUMERIC,
  cost_basis            NUMERIC,
  opened_at             TIMESTAMPTZ,
  condition_id          TEXT,
  end_date              TIMESTAMPTZ,
  market_price_at_entry NUMERIC,
  predicted_prob        NUMERIC,
  payload               JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_pos_cat ON pillar_open_position(category);

-- Closed trades — the analytically load-bearing table (edge-tracker +
-- proper-scoring read it). Fully normalized scalars; signal_breakdown JSONB.
CREATE TABLE IF NOT EXISTS pillar_closed_trade (
  id                    BIGSERIAL PRIMARY KEY,
  category              TEXT NOT NULL,
  seq                   INT NOT NULL DEFAULT 0,     -- preserve array order
  market                TEXT NOT NULL,
  direction             TEXT,
  entry_price           NUMERIC,
  exit_price            NUMERIC,
  shares                NUMERIC,
  pnl                   NUMERIC,
  pnl_pct               NUMERIC,
  opened_at             TIMESTAMPTZ,
  closed_at             TIMESTAMPTZ,
  predicted_prob        NUMERIC,
  market_price_at_entry NUMERIC,
  edge_at_entry         NUMERIC,
  signal_breakdown      JSONB,
  payload               JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_ct_cat ON pillar_closed_trade(category, closed_at);
