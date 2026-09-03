# 18 — Depth-aware fill model (paper execution realizmus)

> **Forrás:** [`roadmap/model-discovery-expansion.md`](../roadmap/model-discovery-expansion.md) §4.A (B49 #1) — a discovery #1 konvergens találata (két független kutató-ág tette az első helyre). **Implementálva:** 2026-09-03 (58. session). **Sprint-tracker:** [`sprints.md` B49](../roadmap/sprints.md#b49).
> **Státusz:** T1–T7 kész, **default OFF** (measure-first). `tsc` exit 0 + 28/28 teszt + build zöld.

---

## 1. A probléma (kódból)

A paper-motor a belépőt teljes méretben, a kijelzett áron töltötte, **könyv-ellenőrzés nélkül**:

```ts
// crypto/execution.mts placeBuyOrder (paper) — LEGACY
record.filledShares = sizeUSDC / price;   // pl. $200 / 0.05 = 4000 share
```

Settlementkor ([`crypto/paper-resolver.mts`](../../services/worker/src/pillars/crypto/paper-resolver.mts)) a fantom share-ök **$1-t kapnak** nyeréskor → a dokumentált +157%-típusú hamis paper-PnL a vékony/longshot piacokon. Az empirikus alap (arXiv 2606.04217): a Polymarketen **fordított favorite-longshot bias** van (a < 0,10 bucket realizált átlaghozama **−0,0023**), és a likviditás Gini **0,970** (a top 1% maker a volumen 84%-a) → egy 5¢-os 4000-share fill fizikailag lehetetlen.

Három over-credit pont, mind a **belépőnél** gyökerezik: (1) belépő teljes fill; (2) settlement `shares × $1`; (3) korai TP/SL exit teljes fill. A **belépő share-cap az (1)-et és (2)-t egyszerre orvosolja** (kevesebb share → kevesebb fantom $1).

---

## 2. A modell (pure math)

[`packages/core/src/fill-model.mts`](../../packages/core/src/fill-model.mts) — tiszta, I/O-mentes, unit-tesztelhető, minden Polymarket-fill bot újrahasználja.

**`simulateDepthFill(asks, requestedUsdc, {participationCap})`** — a BUY az **ask-oldalt** fogyasztja (legolcsóbb elöl):

```
levels = asks szűrve (0<price<1, size>0), ár szerint növekvő
remaining = requestedUsdc
minden szinten:
  takeable = size · participationCap          // vékony-könyv / adverse-selection cap
  costFull = takeable · price
  ha costFull ≤ remaining:  vidd az egész (capelt) szintet
  különben:                 partialShares = remaining / price  (a maradék notionalt)
vwap = filledUsdc / filledShares
partial = filledUsdc < requestedUsdc
```

Kimenet: `{ok, filledShares, filledUsdc, vwap, fillFraction, partial, levelsConsumed}`. `ok=false` **csak** ha semmi sem tölthető (üres/érvénytelen könyv v. nem-pozitív kérés) → a hívó a √-law fallbackre esik.

**Fallback (nincs könyv):** `fallbackFill(refPrice, requestedUsdc, haircut)` — √-law / flat haircutot alkalmaz az **adverse** oldalon (emeli a vételi árat), teljes notional a rosszabb VWAP-on. Soha nem ingyen-teljes-fill a ref-áron. A √-law fractionális impact: `I(Q) = Y·σ·√(Q/V)` (`sqrtLawImpact`).

**Tick/min-size (T5):** `defaultTickForPrice` (a tick < 0,04 / > 0,96 finomodik), `snapDownToTick`, `isPriceOnTick` (a posztolt limit-árra), `isFillValid` (min-order-size share-ben + VWAP ∈ (0,1)).

---

## 3. Bekötés (default OFF)

| Réteg | Fájl | Mit |
|---|---|---|
| Book-fetch (keyless) | [`shared/clob-book.mts`](../../services/worker/src/pillars/shared/clob-book.mts) | `fetchClobBook(tokenId)` — public CLOB `/book`, 5s timeout, hiba→null |
| Belépő fill | [`crypto/execution.mts`](../../services/worker/src/pillars/crypto/execution.mts) `placeBuyOrder` | új `fillOpts` param; ON-nál: book → `simulateDepthFill` → (thin/nincs könyv) fallback → min-size gate; a `record.price=VWAP`, `size=filledUsdc`, `filledShares` a valós fill. Min alatt → `REJECTED` (a runner „failed"-nek veszi). OFF → **bit-azonos** a legacy-vel. |
| Crypto runner | [`pillars/index.mts`](../../services/worker/src/pillars/index.mts) | a `config.fillModelEnabled` + `fillParticipationCap` átadva |
| Weather runner | [`weather/index.mts`](../../services/worker/src/pillars/weather/index.mts) | `getEffectiveFillOpts()` hoistolva a scan elején, átadva a `placeBuyOrder`-nek |
| Sports runner | [`sports/index.mts`](../../services/worker/src/pillars/sports/index.mts) | saját fill-út (nem `placeBuyOrder`) — a book+`simulateDepthFill` inline, a `shares/avgEntry/costBasis`-t felülírja; thin→skip |
| Fee (T6) | [`crypto/paper-resolver.mts`](../../services/worker/src/pillars/crypto/paper-resolver.mts) | ON-nál a settlement-fee **exit-only** (`settlementFeePctFillModel`, default 0,015), mert a belépő slippage már a VWAP-ban van (dupla-számolás elkerülése). OFF → a legacy 0,036 roundtrip. |

**Knobok** ([`trader-settings.mts`](../../services/api/src/routes/trader-settings.mts) SCHEMA, category `common`, group „Execution (paper fill)"): `fillModelEnabled` (0/1, default **0**), `fillParticipationCap` (default **0,20**). Env: `FILL_MODEL_ENABLED`, `FILL_PARTICIPATION_CAP`, `SETTLEMENT_FEE_PCT_FILL_MODEL` → [`env-vars.md`](../current-state/env-vars.md).

---

## 4. Miért default OFF (measure-first)

A repo bevett mintája: a viselkedés-változtató réteg mérés-first. OFF-nál 0 regresszió. Élesítés menete: a knob ON → a prediction-ledger + proper-scoring (Edge Tracker) **hasonlítja** a raw vs fill-modellezett Brier/log-score-t + a < 0,10 bucket realizált hozamát. **A várt eredmény a túl-jóváírt PnL eltűnése, NEM új edge** — a longshot strukturálisan veszít (arXiv 2606.04217), a modell értéke a HŰ PnL, hogy a sizing ne vak tétre menjen.

---

## 5. Maradó (follow-up — sprints.md B49)

- **T6 fee-kalibráció:** a 0,015 exit-only egy becslés (a hold-to-resolution valójában redemption-gas-only; a korai exit spread-only). Méréssel finomítandó; per-position fee-attribúció over-engineering.
- **Élő per-market tick fetch:** a live `placeBuyOrder` még hardcode `tickSize:"0.01"` — a `/tick-size` lekérés live-order-korrektség (B10-blokkolt live-út).
- **Crypto korai TP/SL exit bid-walk:** a `handleSellLifecycle` paper-exit még teljes fill a targeten (másodlagos út — a crypto főleg resolutionön zár, és a belépő-cap arányosan csökkenti a hatását).
- **Weather reconciler fee-parity:** külön kérdés → B35.
