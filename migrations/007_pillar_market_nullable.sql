-- 007_pillar_market_nullable.sql — the Hyperliquid bot's positions/trades key
-- on `coin` (not `market`) and have no `market` field, so the NOT NULL on
-- pillar_open_position.market / pillar_closed_trade.market made every HL
-- saveSession throw (silently swallowed → HL state never persisted). HL's real
-- fields round-trip via the JSONB payload; the normalized `market` column is
-- simply null for HL rows. Drop the NOT NULL. Idempotent (no-op if already
-- nullable).

ALTER TABLE pillar_open_position  ALTER COLUMN market DROP NOT NULL;
ALTER TABLE pillar_closed_trade   ALTER COLUMN market DROP NOT NULL;
