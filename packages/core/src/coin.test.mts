// packages/core/src/coin.test.mts
//
// Regression guard for the shared coin detector + threshold-strike parser
// (sprints.md B51 — crypto multi-coin expansion). Pure, no I/O.
//
// Run: npx tsx packages/core/src/coin.test.mts

import { coinFromText, coinByBase, parseCryptoAboveStrike, isDirectionalCryptoMarket } from "./coin.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}

// ── coin detection ────────────────────────────────────────────────────────
{
  const t = "coinFromText";
  expect(coinFromText("bitcoin-above-78k-on-september-8-2026")?.binance === "BTCUSDT", t, "bitcoin → BTCUSDT");
  expect(coinFromText("btc-updown-4h-123")?.base === "BTC", t, "btc alias");
  expect(coinFromText("ethereum-above-3000-on-september-8-2026")?.binance === "ETHUSDT", t, "ethereum → ETHUSDT");
  expect(coinFromText("eth-up-or-down-on-september-8-2026")?.coingecko === "ethereum", t, "eth alias → coingecko");
  expect(coinFromText("solana-above-200-on-september-8-2026")?.binance === "SOLUSDT", t, "solana → SOLUSDT");
  expect(coinFromText("laptop-fdv-above-100m-one-day-after-launch") === null, t, "non-coin market → null");
  expect(coinFromText("") === null, t, "empty → null");
  // deribit currency present only for BTC/ETH
  expect(coinFromText("bitcoin-x")?.deribit === "BTC", t, "BTC deribit");
  expect(coinFromText("ethereum-x")?.deribit === "ETH", t, "ETH deribit");
  expect(coinFromText("solana-x")?.deribit === null, t, "SOL no deribit");
}

// ── coinByBase ────────────────────────────────────────────────────────────
{
  const t = "coinByBase";
  expect(coinByBase("btc")?.binance === "BTCUSDT", t, "case-insensitive base");
  expect(coinByBase("nope") === null, t, "unknown base → null");
  expect(coinByBase(undefined) === null, t, "undefined → null");
}

// ── threshold strike (BTC k-suffix → USD) ─────────────────────────────────
{
  const t = "parseCryptoAboveStrike/BTC";
  const a = parseCryptoAboveStrike("bitcoin-above-78k-on-september-8-2026");
  expect(a?.K === 78000 && a?.coin === "BTC" && a?.closingKey === "BTC:september-8-2026", t, `78k → 78000 USD: ${JSON.stringify(a)}`);
  expect(parseCryptoAboveStrike("btc-above-65k-on-may-9")?.K === 65000, t, "btc-65k → 65000");
  expect(parseCryptoAboveStrike("will-bitcoin-be-above-100k-on-2026-05-14")?.K === 100000, t, "be-above-100k → 100000");
  expect(parseCryptoAboveStrike("bitcoin-above-77.5k-on-may-9")?.K === 77500, t, "decimal 77.5k → 77500");
}

// ── threshold strike (ETH literal → USD) ──────────────────────────────────
{
  const t = "parseCryptoAboveStrike/ETH";
  const e = parseCryptoAboveStrike("ethereum-above-3000-on-september-11-2026");
  expect(e?.K === 3000 && e?.coin === "ETH" && e?.closingKey === "ETH:september-11-2026", t, `3000 literal → 3000 USD: ${JSON.stringify(e)}`);
  expect(parseCryptoAboveStrike("ethereum-above-1900-on-september-8-2026")?.K === 1900, t, "eth-1900 → 1900");
}

// ── coin-scoped closingKey prevents cross-coin comparison ─────────────────
{
  const t = "closingKey coin-scope";
  const btc = parseCryptoAboveStrike("bitcoin-above-3000k-on-september-8-2026"); // hypothetical BTC 3,000,000
  const eth = parseCryptoAboveStrike("ethereum-above-3000-on-september-8-2026");
  // Same date, but different coins → different closingKey → never compared.
  expect(!!btc && !!eth && btc.closingKey !== eth.closingKey, t, "BTC vs ETH same date → distinct closingKey");
}

// ── negatives ─────────────────────────────────────────────────────────────
{
  const t = "parseCryptoAboveStrike/neg";
  expect(parseCryptoAboveStrike("bitcoin-up-or-down-on-september-8-2026") === null, t, "up-or-down → null");
  expect(parseCryptoAboveStrike("eth-up-or-down-15m") === null, t, "eth up-or-down → null");
  expect(parseCryptoAboveStrike("ratio-bitcoin-above-80k-something") === null, t, "non-anchored suffix → null");
  expect(parseCryptoAboveStrike("laptop-fdv-above-100m-one-day-after-launch") === null, t, "non-coin above → null");
  expect(parseCryptoAboveStrike(undefined) === null, t, "undefined → null");
  expect(parseCryptoAboveStrike("") === null, t, "empty → null");
}

// ─── CLI report ────────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("coin.test.mts") || entry.endsWith("coin.test.js");
  } catch { return false; }
})();

// ── isDirectionalCryptoMarket (audit P0-3) ───────────────────────────────────
// Pins the LIVE incident, not an invented example. For 2412 consecutive scans
// the Hyperliquid pillar resolved BTC to `bitcoin-above-82k-on-september-9-2026`
// (YES 0.0365, deep OTM) and fed that probability into `edge = |p−0.5|×2`,
// manufacturing a 96.9% edge out of pure moneyness. Every slug below was
// observed in the live Gamma response on 2026-09-09.
{
  const t = "directional-market";

  // The slugs that actually broke it — all must be refused.
  for (const bad of [
    "bitcoin-above-82k-on-september-9-2026",
    "bitcoin-above-84k-on-september-9-2026",
    "bitcoin-above-74k-on-september-9-2026",
    "bitcoin-above-72k-on-september-9-2026",
    "bitcoin-above-76k-on-september-9-2026",
    "solana-above-105-on-september-9-2026",
    "ethereum-above-2600-on-september-9-2026",
  ]) {
    expect(isDirectionalCryptoMarket(bad) === false, t, `threshold market must NOT be directional: ${bad}`);
  }

  // The markets the bot was always supposed to use — all must be accepted.
  for (const good of [
    "bitcoin-up-or-down-on-september-9-2026",
    "bitcoin-up-or-down-september-4-2026-9pm-et",
    "ethereum-up-or-down-on-september-9-2026",
    "solana-up-or-down-on-september-9-2026",
  ]) {
    expect(isDirectionalCryptoMarket(good) === true, t, `up-or-down market must be directional: ${good}`);
  }

  // Unrecognised input is NOT directional. The bug was a silent
  // mis-classification, so the default has to be refusal, never a guess.
  for (const unknown of [
    "highest-temperature-in-london-on-september-9-2026",
    "ucl-fcb-fey-2026-09-09-fcb",
    "",
    null,
    undefined,
    "some-random-market",
  ]) {
    expect(isDirectionalCryptoMarket(unknown as any) === false, t,
      `unrecognised input must default to NOT directional: ${String(unknown)}`);
  }

  // "above"/"below" wording is refused even when the strike itself fails to
  // parse — otherwise an unusual format would slip straight back through.
  expect(isDirectionalCryptoMarket("bitcoin-up-or-down-but-above-80k-weird") === false, t,
    "a slug naming a strike must be refused even if the strike parser misses it");
  expect(isDirectionalCryptoMarket("btc-market", "Will Bitcoin be above $80,000?") === false, t,
    "threshold wording in the QUESTION must be refused too");

  // Consistency with the existing threshold parser: anything it parses is, by
  // definition, not directional.
  for (const slug of ["bitcoin-above-82k-on-september-9-2026", "ethereum-above-2600-on-x", "solana-above-105-on-y"]) {
    if (parseCryptoAboveStrike(slug)) {
      expect(isDirectionalCryptoMarket(slug) === false, t, `parser and classifier must agree on ${slug}`);
    }
  }
}

if (isMain) {
  if (failures.length === 0) {
    console.log("coin.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`coin.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
