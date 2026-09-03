# 22 — OI-Δ × price signal (leverage-flow, a 9. combiner-signal)

> **Forrás:** [`roadmap/model-discovery-expansion.md`](../roadmap/model-discovery-expansion.md) §4.D (B49 #5) — a discovery **TOP új korrelálatlan signalja**. **Implementálva:** 2026-09-03 (62. session). **Sprint-tracker:** [`sprints.md` B49](../roadmap/sprints.md#b49).
> **Státusz:** kész, **default-OFF** (anti-overfit: a combiner nem nő live-ban mérés előtt). `tsc` exit 0 + 32/32 teszt + build zöld.

---

## 1. Miért ez a top új signal

A meglévő `orderflow` a **passzív könyv-imbalance-t** méri (nyugvó likviditás). A **nyílt kamat (open interest) változása** a **pozíció-életciklust** méri (nyitott vs zárt kontraktusok) — ortogonális információ. A klasszikus leverage-flow olvasat az **OI-Δ × ár kvadráns**:

| Ár | OI | Kvadráns | Olvasat |
|---|---|---|---|
| ↑ | ↑ | **fresh_longs** | friss longok → trend **megerősítve** |
| ↑ | ↓ | **short_covering** | short-cover → **gyenge** rally (zárás, fade) |
| ↓ | ↑ | **fresh_shorts** | friss shortok → down-move **megerősítve** |
| ↓ | ↓ | **long_unwind** | deleverage → **gyenge** selloff (pattanhat) |

Vagyis: **emelkedő OI megerősíti** a mozgást; **csökkenő OI** = a mozgás csak pozíció-zárás → diszkontáld. Ingyenes Binance-adat, natívan **multi-coin** → a legtisztább út a BTC-hardcode leváltására (→ new-strategies #3).

---

## 2. A matek (pure)

[`packages/core/src/oi-delta.mts`](../../packages/core/src/oi-delta.mts) — tiszta, I/O-mentes.

- `classifyOiQuadrant(priceReturn, oiChange, flat=0.0005)` → a fenti 5 kvadráns (a `flat` alatti ármozgás = `neutral`).
- `oiDeltaProb(priceReturn, oiChange, opts)` → **P(up)** ∈ [lo,hi] (ugyanaz a P(YES/up) cél, amit a combiner használ):
  ```
  prob = clamp( 0.5 + sign(pr)·min(|pr|,prCap)·scale·conf , lo, hi )
  conf = (oiChange ≥ 0) ? 1 : confDampen     // emelkedő OI teljes tilt; csökkenő → gyengítve
  ```
  defaultok: `scale=8`, `prCap=0.05` (5% ársapka), `confDampen=0.3`, `[lo,hi]=[0.05,0.95]`, `flat=0.0005`. Neutral ármozgás → 0.5. 5-csoportos [teszt](../../packages/core/src/oi-delta.test.mts): kvadráns, confirm-irány+szimmetria, dampen (0.3× tilt), magnitude+cap+clamp, neutral+invalid.

---

## 3. Bekötés (default-OFF)

[`signal-combiner.mts`](../../services/api/src/routes/signal-combiner.mts):
- `parseCoinSymbol(market)` — a coin a slug/question-ből (bitcoin→BTCUSDT, ethereum→ETHUSDT, solana→SOLUSDT, xrp/doge/avax/bnb). Ismeretlen → null (nincs signal). Így a HL (`<coin>-up-or-down`) minden coinja a saját OI-feedjét kapja.
- `getOiDeltaSignal(market)` — knob-gate (`oiDeltaEnabled`, ha ≠1 → **null** → a combine() elejti → 8-signal output **bit-azonos**); különben Binance `futures/data/openInterestHist` (5m×7 ≈ 30 perc) + `fapi/v1/klines` → `oiChange`, `priceReturn` → `oiDeltaProb`. Detail: symbol, priceReturnPct, oiChangePct, quadrant.
- Bekötve: `SIGNAL_ICS.oi_delta = 0.07`; **`K_BLIND_SIGNALS`-hoz adva** (strike-blind → threshold `bitcoin-above-K` piacon a K-blind downweight csökkenti, mint a momentum/contrarian/funding/pairs); `raw_signals.oi_delta`; a Promise.all-ba. A combine() generikusan iterál a signal-kulcsokon → automatikusan beépül.
- [`types.mts`](../../packages/core/src/types.mts): `SignalBreakdown.oi_delta?` **opcionális** mező (pre-#5 rekordok/producerek érvényesek maradnak).
- Knob: `oiDeltaEnabled` (0/1, default **0**) a SCHEMA-ban (category `common`, group „Signal toggles"). Settings-only (nincs env-fallback).

---

## 4. Miért default-OFF + measure-first

A `new-strategies.md` anti-sprint szabálya: **a 8-signal combiner nem nőhet live-ban 200 trade előtt.** A default-OFF ezt tiszteletben tartja: OFF-nál a signal null → 0 regresszió. Élesítés: knob ON → az Edge Tracker realized-IC (Signal IC calibration) + a #4 walk-forward mutatja, hogy az `oi_delta` valós korrelálatlan edge-et ad-e → pozitív igazolás után marad ON. A prior IC (0,07) csak kiindulás; a realized-IC blend (B34, `useRealizedIC`) felülírja.

---

## 5. Maradó (follow-up — sprints.md B49)

- **BTC-hardcode teljes leváltása** a crypto Polymarket-oldali feedeken (a #3 new-strategies): jelenleg az OI-Δ már multi-coin, de a `vol_divergence`/`funding_rate` még BTC-hardcode a threshold-combinerben — külön tétel.
- **Funding cross-section percentilis-rank** (#17 / discovery §4.D #3) — külön, komplementer signal.
- **Window-tuning** (5m×7) méréssel; opcionális `oiDeltaWindowBars` knob, ha kell.
