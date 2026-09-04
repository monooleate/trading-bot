# CHANGELOG — 2026-09-04

## Élő trade-audit (a 10-knob enable után) → 1 bug: oi_delta nem trackelt a ledgerben

A user: „nézd meg a trade-eket és ellenőrizd, hogy minden rendben történik-e a kóddal." Élő audit a boxon (`ssh analytics`, Postgres + worker-logok), a most bekapcsolt 10 knob melletti helyes működésre.

**Verifikált OK:**
- **Weather PnL bit-pontos:** London NO 7.13×(1.0−0.46)=+3.85 ✓; HK/Paris/Seoul veszteségek stimmelnek; Σ=−10.44 ✓.
- **Fill-modell él és helyes:** a crypto open pozíciókon `avg_entry (VWAP) > market_price_at_entry (touch)` (pl. 0.26 > 0.245) → az ask-könyvet lépegeti, reális slippage, kevesebb share mint a naiv touch-fill.
- **HL PnL nem veszett el:** a normalizált `pnl`/`shares`/`market` oszlop üres HL-nél (a `pnlUSDC`/`sizeCoins`/`coin` a `payload` JSONB-ben), de a bankroll **bit-pontosan rekonciliál** (200 + Σ pnlUSDC 0.16 = 200.16) → a rebuild helyesen olvassa.
- **Config-stamp (#4) él:** weather 7/14, crypto 7/20 rekord stampelve; a legfrissebb (enable utáni) rekordok a 10-knob hash-t (`3683673b`) hordozzák → az új config a trade-eken át hat.
- **0 hiba/exception/NaN** a logokban; az egyetlen skip egy **helyesen tüzelő guardrail** (trust-gate: WATCH + 20.2% edge → „likely model error").

**Bug (javítva):** az `oi_delta` signal (`oiDeltaEnabled=1`) a combinerben **helyesen számol** (direkt hívás: `oi_delta: 0.509`, mind a 9 signal jelen → **hat a finalProb-ra, a trading-döntésre**), DE a worker [`crypto/signal-aggregator.mts`](../../services/worker/src/pillars/crypto/signal-aggregator.mts) `extractBreakdown`/`emptyBreakdown` fix signal-listája **kihagyta** → a ledger `signalBreakdown`-ja mind a 20 rekordon `oi_delta: NULL`. Következmény: a signal HAT a döntésre, de a **per-signal realized-IC / edge-tracker attribúció nem trackelte** → a #5 measure-first értékelése (segít-e az OI-Δ) nem működött volna. **Fix:** `oi_delta: rawSignals.oi_delta ?? null` mindkét builderbe. `tsc` exit 0 + 44/44 teszt + build zöld. A fill-forward miatt az új rekordoktól trackelt.

**Verdikt:** a 10-knob enable utáni élő trading **helyesen működik** — a fill-modell, PnL, config-stamp, guardrailek mind rendben; az egyetlen találat egy mérés-completeness bug (oi_delta attribúció), javítva.
