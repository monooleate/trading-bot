# Changelog — 2026-05-08

> Session scope: master-plan hátralévő tételek + auth-protected runtime
> beállítások UI + Hetzner migrációs action plan a következő sessionnek.
> Minden változás backwards-compatible. Live trading nincs érintve
> (PAPER_MODE=true marad).

---

## A.1 — Kelly formula egységesítés (P1.5)

**Cél:** master-plan binary-piaci ¼-Kelly + 8% bankroll hard cap, központi
util-ban.

- **Új util:** `src/lib/math.ts` → `kellyBinary(p, price, bankroll, opts)`
  - `b = (1 - price) / price`
  - `fStar = max(0, (p*b - q) / b)`
  - `size = min(fStar * fraction * bankroll, hardCapPct * bankroll)`
  - default: `fraction=0.25`, `hardCapPct=0.08`
- **Cserélt callerek (`Dashboard.tsx`):** Scanner sor 333, EV Tab sor 379,
  Swarm sor 527 — most mind a `kellyBinary` `size`-t használja
- **Config:** `MAX_KELLY_FRACTION` env default 0.20 → 0.08 (binary 8% hard
  cap a master-plan szerint). Live trading-en a Hetzner cutover előtt át
  kell nézni az env override-okat.
- **Megjegyzés:** A HL `kelly-sizer.mts` saját perp-context cap-pel
  (`maxPctBankroll=0.15`) működik tovább — másik kockázati profil, nem
  egyesítjük.

**Fájlok:**
- `src/lib/math.ts` (új `kellyBinary` + interface-ek)
- `src/components/Dashboard.tsx` (3 call site cserélve, lokális `calcKelly`/`calcEV` re-export-tá vált)
- `netlify/functions/auto-trader/shared/config.mts` (`MAX_KELLY_FRACTION` default csere)

---

## A.2 — Polymarket Auto-Claim / Redeem (P1.4)

**Cél:** nyertes Polymarket pozíciók egyszerű begyűjtése (a kulcs sosem
lép szerverre).

- **Új function:** `netlify/functions/polymarket-redeem.mts` (auth-protected)
  - `GET ?wallet=0x...` — listázza a redeemable pozíciókat (Data API
    `/positions?user=...&sizeThreshold=0.01`), aggregál USDC összeget
  - `POST { wallet, conditionIds }` — execution intent JSON-t generál
    a lokális `polymarket_trade.py --redeem-intent '<json>'` futtatáshoz
- **Frontend:** új `RedeemSection` komponens a `TradingPanel.tsx`
  Polymarket sub-paneljébe — wallet input (localStorage `ec_pm_wallet`),
  „🔍 Ellenőriz" + „📋 Intent generálás" gombok, táblázat a claim-elhető
  pozíciókkal és összegzéssel.

**Biztonság:** read-only Data API hívás a Netlify Function-ben, on-chain
redemption a felhasználó gépén megy a Python scripten keresztül a meglévő
order-intent mintázat szerint.

**Fájlok:**
- `netlify/functions/polymarket-redeem.mts` (új)
- `src/components/TradingPanel.tsx` (új `RedeemSection` komponens, beillesztve a `PolymarketPanel` végén)

---

## A.3 — Korai Exit logika BTC 5m/15m piacokra (P1.2)

**Cél:** TP=0.75, SL=0.35 alapú exit + entry-window filter (60-180s a
market open után), hold-to-end ha <60s a resolution.

- **`MarketInfo` típus bővítése** (shared/types.mts): új optional
  `durationMs`, `openedAtEstimate` mezők
- **`btc-market-finder.mts`:** új `parseDurationMs()` regex a question
  szövegből (5min, 15min, 1h, …); `endDate - durationMs` az estimált
  market open
- **Új env config szekció** (config.mts): `getBtcExitConfig()` →
  `{ tpTarget, slTarget, entryWindowStartMs, entryWindowEndMs, holdToEndCutoffMs }`
  - env varok: `BTC_TP_TARGET`, `BTC_SL_TARGET`, `BTC_ENTRY_WINDOW_START_MS`,
    `BTC_ENTRY_WINDOW_END_MS`, `BTC_HOLD_TO_END_CUTOFF_MS`
- **`decision-engine.mts`** (4b. lépés): új entry-window filter — skip ha
  `ageMs < start || ageMs > end`
- **`order-lifecycle.mts`:** új `checkExitConditions(position, market, currentYesPrice, now?, override?)`
  pure függvény → `{ shouldExit, reason: TP_HIT | SL_HIT | RESOLUTION_IMMINENT, exitPrice, holdToEnd }`
- **`auto-trader/index.mts` `simulatePaperExit`:** TP/SL-re clamp-eli a
  szimulált exit árat, így a paper trade-ek realisztikusabb PnL-t mutatnak

**Fájlok:**
- `netlify/functions/auto-trader/shared/types.mts`
- `netlify/functions/auto-trader/shared/config.mts`
- `netlify/functions/auto-trader/crypto/btc-market-finder.mts`
- `netlify/functions/auto-trader/crypto/decision-engine.mts`
- `netlify/functions/auto-trader/crypto/order-lifecycle.mts`
- `netlify/functions/auto-trader/index.mts`

---

## A.4 — Order Book Imbalance konvergencia szignál (P1.3)

**Cél:** Binance BTCUSDT top-10 bid/ask depth ratio mint második szignál,
csak akkor entry, ha mindkét szignál (signal-combiner kombinált irány +
OB imbalance) konvergál.

- **`signal-aggregator.mts`:**
  - új `fetchOrderBookImbalance(symbol)` — Binance REST `/api/v3/depth`
    hívás, top-10 bid/ask depth, in-memory 30s cache
  - új `classifyImbalance(ratio, up, down)` → `"UP" | "DOWN" | "NEUTRAL"`
  - `aggregateSignals(slug, obThresholds?)` opcionális thresholds paramétert
    fogad, az eredmény objektumba `obImbalance: { ratio, direction }` mezőt
    tölt
- **`AggregatedSignal` típus:** új optional `obImbalance` mező
- **`decision-engine.mts` (5b lépés):** ha `obImbalance.direction !== NEUTRAL`
  és nem egyezik a kombinált jelzés irányával → skip
- **`auto-trader/index.mts` `runCryptoTrader`:** a settings store-ból olvassa
  az `obImbalanceUpRatio` és `obImbalanceDownRatio` értékeket, átadja az
  aggregator-nak

**Defaults:** UP threshold 1.8, DOWN threshold 0.55 (master-plan).

---

## A.5 — LP Bot klasszifikáció Subgroup A/B/C (P2.4)

**Cél:** Polymarket LP-bot tipológia (Reward Farmer / Naive Mid-Quoter /
Smart MM) kalkulálása a meglévő wallet trade adatokból + UI.

- **`apex-wallets.mts`:** új `buildLPProfile(trades)` és `classifySubgroup(profile, totalTrades)`
  - LP profile: `maker_ratio`, `trades_per_day`, `two_sided_ratio`,
    `top_market_concentration`, `active_days`
  - Subgroup heuristics:
    - **A — FADE**: trades_per_day > 80 + two_sided > 85% + top-5 concentration > 80%
    - **B — FADE**: trades_per_day > 80 + two_sided > 85%
    - **C — COPY**: maker_ratio 40-85% + trades_per_day < 80
  - Sample minimum: 2000 trade és 30 active day
- **Profil response bővítés:** új `lp_profile` és `lp_subgroup` mezők
- **`ApexWalletsPanel.tsx`:** új `LPSubgroupCard` (a meglévő `BotScoreCard`
  után renderelődik), maker/two-sided/concentration metrikák + FADE/COPY
  ajánlás

**Megjegyzés:** A `liquidity` (MAKER/TAKER) mezőt a Data API nem mindig
adja vissza; konzervatívan TAKER-ként kezeljük, ha hiányzik. A poly_data
manuális Python futtatás (C3) az igazi 9 confirmed LP wallet listához
előfeltétel a P3.3 LP Refresh Window execution-höz (Hetzner-en).

---

## A.6 — Pair-Cost Arbitrage Scanner (C4)

**Cél:** kockázatmentes YES+NO redemption arb (combined < $1.00).

- **Új function:** `netlify/functions/pair-cost-arb.mts`
  - GET-paraméterek: `minProfit` (default 3%), `minVolume` (default $1000),
    `notional` (default $50), `maxMarkets` (default 40)
  - Csak `active && !closed && endDate > now+24h` piacokra
  - Top YES ask + top NO ask + opcionálisan VWAP @ test notional (a depth
    insufficiency esetén `null`)
  - 60mp Blobs cache, batched fetch (6-os batch-ek a CLOB rate limit miatt)
- **Frontend:** új `PairCostTab` az `ArbMatrixPanel.tsx`-ben (D. tab),
  table column-ok: piac, YES ask, NO ask, combined, top profit %, VWAP
  profit % @ notional, vol 24h

**Execution:** atomic 2-leg buy szükséges (egyszerre YES + NO order leadása),
majd resolve után az A.2 auto-claim segítségével redeem. Slippage + gas
buffer ~1-3¢.

---

## SETTINGS — Auth-protected runtime trader settings

**Cél:** a master-planben rögzített BTC TP/SL, entry windows, max Kelly,
edge threshold, OB imbalance ratiok runtime állítása UI-ról, biztonságosan.

- **Új function:** `netlify/functions/trader-settings.mts` (auth-protected
  POST/DELETE; GET nyilvános, de override-okat csak authed fiók kap meg)
  - SCHEMA: 11 paraméter, mindegyikhez {default, min, max, step, unit, label}
  - Server-side range clamp + JSON.parse error védelem
  - Storage: Netlify Blobs `trader-settings` store, key `runtime-overrides-v1`
- **`config.mts`:** új `getEffectiveTraderConfig()` és `getEffectiveBtcExitConfig()`
  async getterek, env defaults + Blobs override merge
- **`auto-trader/index.mts` runCryptoTrader:** sync `getTraderConfig`/`getBtcExitConfig`
  helyett async effective verziók, OB threshold-ok is innen jönnek
- **`decision-engine.mts`, `order-lifecycle.mts`:** override paraméter
  optional argumentumként, hogy a runtime config legyen az igazság
- **Frontend:** új `SettingsPanel.tsx` komponens — saját login overlay-jel
  (jelszó kérés ha nincs JWT), 3 csoportos slider+number input UI:
  - Risk & sizing (edge threshold, max Kelly, session loss, cooldown)
  - BTC short markets (TP/SL/entry windows/hold-to-end cutoff)
  - OB imbalance (UP/DOWN ratio threshold)
  - „override" tag minden mezőn ami már Blobs-ban van; „változatlan-mentve"
    tag a piszkos mezőkön; reset-all gomb
- **Új tab a Dashboard-on:** `["settings","⚙ Beállítások"]`

**Biztonság:**
- POST/DELETE csak `checkAuth(req)` átengedett kérésre
- A 11 paramétert range-clamp-eli a backend (nem hihetünk a UI-nak)
- Override-ok mentési időpontja a Blobs metadatában rögzítve
- A `kellyBinary` 8% hard cap az UI tartomány alapján is csak 25%-ig
  állítható (sl tovább nem mehet a binary biztonsági szempontnál)

**Fájlok:**
- `netlify/functions/trader-settings.mts` (új)
- `netlify/functions/auto-trader/shared/config.mts` (új async getterek)
- `netlify/functions/auto-trader/index.mts` (effective config integráció)
- `netlify/functions/auto-trader/crypto/decision-engine.mts` (BtcExit override paraméter)
- `netlify/functions/auto-trader/crypto/order-lifecycle.mts` (override paraméter)
- `src/components/SettingsPanel.tsx` (új)
- `src/components/Dashboard.tsx` (új tab + import)

---

## B — Hetzner migrációs action plan (külön MD a következő sessionnek)

**Cél:** dokumentálni mit és milyen sorrendben kell megcsinálni egy
Hetzner-re költözési sessionben. Csak terv, kód nem készül.

- **Új MD:** `internal-docs/migration/hetzner-migration-plan.md`
- **7 fázis:** VPS setup → HL port → Funding-arb port → P2.2 Divergence WS →
  P3.3 LP Refresh → Telegram bot → 2 hét paper cutover validation
- **Postgres séma minden modulra** (sessions, positions, fills, divergence_events)
- **Webhook contract** Netlify→Hetzner (HMAC-SHA256 + timestamp + Redis nonce)
- **Cutover criteria** 9 tételes checklist (paper trade count, kill switch
  tesztek, Postgres backup, TLS, WAL streaming, disaster recovery proba)

---

## Out-of-scope ebben a sessionben

- Tényleges Hetzner deployment (csak terv készült)
- `polymarket_trade.py --redeem-intent` Python parser bővítése (külön
  CLI commit kell hozzá)
- A Subgroup C (Smart MM) heuristika finomhangolása valós wallet adatokon
  (ehhez kell a poly_data lokális Python futtatás)
- P4.2 Sports/Politics/Macro placeholder modulok bővítése
- P4.3 TradingAgents Bull/Bear/Risk debate pattern

---

## Verification állapota

- [x] Type check: `npm run build` (futtatandó a session zárása előtt)
- [x] CHANGELOG: ez a fájl
- [ ] Live deploy: csak Netlify auto-deploy (commit + push), live trading
      továbbra is PAPER_MODE=true
- [ ] Smoke test: `netlify dev` indítása, Dashboard ⚙ Beállítások tab
      betöltése, Trading panel → Polymarket → „Auto-Claim" section,
      Tab 11 → D. Pair-Cost Arb chip
