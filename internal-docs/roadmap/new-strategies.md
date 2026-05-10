# EdgeCalc — New Strategies Roadmap

> **Dátum:** 2026-04-24
> **Cél:** A korábbi beszélgetésben felsorolt 36 bővítési ötlet + 1 új (apex v2 a polyterm minták alapján) = **37 ötlet rangsorolva** **pilléres modellben**, **a meglévő 5 pillér + Bybit-execution architektúrára** szabva. Mit építs **most**, mit **6 hónap múlva**, mit **soha**.
> **Filozófia:** Az edge nem a stratégiák *számából*, hanem a **független edge-források × kalibrált sizing × walk-forward validation** szorzatából jön. Ezért minden új stratégia **paper proof-on megy keresztül**, mielőtt live.

---

## 0. Rangsorolási kritériumok

Minden ötletet 4 dimenzió mentén értékelek:

- **Edge potenciál** (1-5): mekkora reális edge-et hozhat
- **Build complexity** (1-5): mennyi munka megépíteni
- **Marginal value** (1-5): mennyit ad hozzá a *meglévő* rendszerhez (ha a meglévő signal-ek már lefedik, kicsi)
- **Risk asymmetry** (1-5): downside vs upside (5 = nagy upside, kis downside)

**Score = (Edge × Marginal × RiskAsym) / Complexity**, magasabb = előbb építsd.

---

## 1. RANGSOR — Top 11 (most-soon, 0-6 hónap)

### #1 — Bug fix: apex-wallets consensus piac-nevek (Score: ∞)
**Mit**: A jelenlegi `apex-wallets.mts` rossz piac-neveket ad (architecture.md §14 ismert bug). A `/trades` response már tartalmazza a `title`/`slug` mezőt, de a kód külön Gamma lookup-ot csinál `conditionId` alapján, ami félrevezetők.

**Build**: 1-2 óra. Egyszerű refactor.

**Miért #1**: Ez nem új stratégia, hanem **a meglévő signal helyes működése**. A signal-combiner gyakran WAIT-et ad, mert az apex_consensus signal félrevezet. **Ez a legnagyobb low-hanging fruit.**

**Indító**: ASAP, még a VPS migráció előtt.

---

### #2 — Apex-wallets v2: insider + smart money consensus (Score: 9.5)
**Mit**: A jelenlegi `apex-wallets` signal egy alap whale aggregátor. Bővítjük 4 új sub-signallal a polyterm minták alapján (saját TS implementáció, nem dependency):

1. **Insider detection scoring** — wallet aktivitás minta alapján gyanús pre-event trade flag-elés:
   - Új wallet (< 30 napos) + első nagy trade ($5k+) + market deadline közeli = magas insider score
   - Single-market focus (egy wallet csak 1-2 piacon kereskedik) + nagy size = gyanús
   - Output: 0-100 insider score per trade
2. **Smart Money Consensus** — top N wallet long/short bias **PnL-súlyozva**:
   - Jelenlegi: top 10 wallet equal-weight buyPct
   - Új: PnL-súlyozott consensus (egy +$50k wallet 5x súlyú, mint egy +$10k)
   - Win rate filter: csak wallets > 60% historical win rate
3. **Wash trade detection** — ugyanaz a wallet BUY+SELL ugyanazon a piacon rövid időn belül:
   - Excluded a consensus-ból, ne torzítson
   - Az architecture.md POLYMARKET_ANALYSIS_2025 doksi szerint: **Columbia University study found 25% of Polymarket volume is "artificial" from wash trading**. Ez nagy zaj, amit szűrni kell.
4. **Followed wallet alerts** — te kijelölsz 5-10 trusted wallet-et, real-time Telegram alert ha tradelnek:
   - Postgres `tracked_wallets` tábla
   - Polymarket Data API `/trades` poll 30 másodpercenként
   - Külön Telegram csatorna (TELEGRAM_CHAT_ID_WHALE_ALERTS)

**Build**: 2-3 hét. Új modulok az `signal/apex-wallets/` alatt:
- `insider-detector.ts` (heurisztika-alapú scoring)
- `smart-money-consensus.ts` (PnL-súlyozott aggregáció)
- `wash-detector.ts` (BUY+SELL pattern detektor)
- `followed-wallets.ts` (per-user wallet tracking)
- Új Postgres táblák: `tracked_wallets`, `wallet_pnl_history`, `wash_flags`

**Miért #2**: Minden meglévő pillér **azonnal profitál**, mert a signal-combiner consume-olja. **Plusz**: új független edge-forrás (insider score), ami nem korrelál a vol-divergence/orderflow signal-okkal. **A polyterm referenciaként hasznos** a logikai minta szempontjából (Python kód, TS-re átírva), de **NEM dependency** — saját implementáció.

**Indító**: A #1 (apex bug fix) után közvetlenül, még a VPS migráció Fázis 2 alatt. Ha csak Fázis 7 után jönne, akkor **6 héttel csúszik a benefit minden pillérre**.

**Mit szállít**:
- 4 új apex sub-signal a `signal-combiner`-be (mind külön IC prior, mind külön kalibrálható)
- Új Tools tab a /tools dashboard-on: "Apex v2 Insider Scanner" — manual exploration UI
- Followed wallet management UI (track/untrack wallet-eket)
- Telegram alert pipeline a followed wallet-ekre

**Risk**: A insider detection **heurisztika-alapú**, nem ML. Lehet false positive (új wallet + nagy trade != mindig insider). Ezért az insider score **csak filter, nem direct trade trigger** — a signal-combiner-en keresztül súlyozódik a többi signallal.

---

### #3 — Per-coin signal-combiner slug map (Score: 9.0)
**Mit**: Jelenleg a signal-combiner BTC-fókuszú (vol_divergence, funding_rate mind BTCUSDT-re néz). HL-en ETH/SOL/XRP/DOGE pillérek prob ≈ 0.5-öt kapnak → értelmetlen döntés.

**Build**: 1-2 nap. Per-asset slug + ticker map (BTC→BTCUSDT, ETH→ETHUSDT, SOL→SOLUSDT), és minden signal-ben paraméterezetten az asset-specifikus feed-et használja.

**Miért #3**: Az `pillar-hl-directional` jelenleg **csak BTC-en működik értelmesen**. ETH/SOL nélkül a HL pillér diverzifikáció-vesztett.

**Indító**: VPS migráció Phase 2 (signal layer átköltöztetés) idején.

---

### #4 — Real-time WebSocket VWAP scanner (Score: 8.5)
**Mit**: A jelenlegi `vwap-arb.mts` 90 másodperces REST cache-t használ. Egy igazi VWAP arb-hez **per-block** vagy **streaming** kell.

**Build**: 1 hét. Polygon WebSocket subscription + per-block VWAP computation + Redis pub/sub.

**Miért #4**: A jelenlegi VWAP signal **lemaradás**, nem arb. WS-szel lesz tényleg edge.

**Indító**: VPS migráció Phase 2-3 között.

---

### #5 — Walk-forward backtest framework (Score: 8.5)
**Mit**: Minden új signal/pillér előtt: rolling window train/test, look-ahead bias eliminálva, out-of-sample validation.

**Build**: 1-2 hét. Postgres trade history → backtest engine (vitest-szerű API), strategy plug-in pattern.

**Miért #5**: Ez **a legfontosabb infrastruktúra-investment** a hosszú távú profitabilitáshoz. A 36 ötletből egyik se megy live, ha nem futott végig walk-forward backtesten.

**Indító**: VPS migráció Phase 5 után, mielőtt új pillér jön.

---

### #6 — Brier score + reliability diagram per-pillér (Score: 8.0)
**Mit**: Minden trade-nél már elmentjük a `predicted_prob`-ot és a `realized_outcome`-t. Brier score = mean squared error a predikciók és outcome-ok között. Reliability diagram = predikció-bin vs realized rate plot. **Megmondja, hogy a bot kalibrált-e.**

**Build**: 2-3 nap. SQL query + Postgres materialized view + Edge Tracker UI bővítés.

**Miért #6**: Ha kiderül hogy a pillér **predicted 70% rate-en csak 50%-ot teljesít**, sose lesz pénz. Ez a leggyorsabb módja annak, hogy meglásd melyik signal hazudik. Olcsó és nagyon informatív.

**Indító**: VPS migráció Phase 7 után (50+ live trade-en már működik).

---

### #7 — Liquidation cascade detection (Score: 7.5)
**Mit**: Binance `!forceOrder@arr` WebSocket stream → cascading liquidations real-time → opposite side trade (cascade tetején fade-elni).

**Build**: 1-2 hét. binance-ws-collector már subscribe-el rá (hetzner-infrastructure.md), kell egy detektor: 30s window-ban X+ liquidation, >Y million USD össz → trigger.

**Miért #7**: **Új edge forrás**, nem korrelál a meglévő signal-okkal. **Aszimmetrikus risk** — a cascade ritka, de nagy mozgással jár, és ezeket a meglévő signal-ek nem fogják.

**Indító**: A latency-arb pillér után (Phase 8), mint új pillér: `pillar-cascade-fade`.

---

### #8 — GARCH(1,1) volatility forecasting (Score: 7.0)
**Mit**: A vol-divergence signal jelenleg sima close-to-close RV-t használ. GARCH(1,1) figyelembe veszi a vol clustering-et → jobb prior az IV-RV spread-hez.

**Build**: 3-5 nap. `arch-py` Python service vagy native TS implementáció (~200 LOC), Redis cache 1h.

**Miért #8**: Direkt javítja a vol-divergence signal pontosságát, ami az egyik legmagasabb IC-jű signal. Marginal gain a meglévő rendszeren.

**Indító**: 3-4 hónap múlva, Phase 9 után.

---

### #9 — Cross-platform arb: Polymarket vs Kalshi (Score: 7.0)
**Mit**: Ugyanaz az event (pl. "Will Bitcoin be above $100k by EOY") két platformon eltérő áron árazódik. Long olcsóbb platform + short drágább = arb.

**Build**: 2-3 hét. Kalshi API integráció, market matching engine (NLP — két market ugyanaz-e?), settlement risk handling (Kalshi T+1 cash, Polymarket azonnal).

**Miért #9**: **Új venue, új edge source**, regulatórikusan tiszta (Kalshi US licensed). De: Kalshi US-only, és magyarországi access-szel komplikáció lehet (KYC, fund movement).

**Indító**: 4-6 hónap múlva, csak ha a Kalshi access megoldható EU-ból.

---

### #10 — Twitter/X sentiment scoring (Score: 6.5)
**Mit**: Tweet volume + sentiment + influencer detection (Elon Musk tweet → BTC reaction). Claude vagy lokális classifier scoring.

**Build**: 2-3 hét. Twitter API access (Elon megdrágította, ~$200/hó), tweet stream filter, sentiment classifier, signal generator.

**Miért #10**: News-driven move-okhoz hasznos signal, ami nincs a meglévő technikai signal-okban. **De**: drága ($200/hó) és néha félrevezet.

**Indító**: 6 hónap múlva, opcionális.

---

### #11 — Hidden Markov Model regime detection (Score: 6.5)
**Mit**: 3 állapotú HMM (trending, mean-reverting, chop). Minden állapotban más stratégia érvényes. Például a momentum signal csak trending regime-ben kapcsoljon be.

**Build**: 1-2 hét. `hmmlearn` Python service vagy native TS, daily retraining.

**Miért #11**: A meglévő stratégiák **regime-blind**. Egy regime-aware filter dramatically javíthatja a win rate-et.

**Indító**: 4-6 hónap múlva.

---

## 2. RANGSOR — Mid (6-12 hónap)

### #12 — Cointegration / pairs trading (BTC/ETH spread)
- **Build**: 2 hét
- **Score**: 6.0
- BTC/ETH long-term cointegration spread, mean reversion ha kilép a confidence band-ből
- Új pillér: `pillar-pairs-btc-eth` (Bybit hedged pair)

### #13 — On-chain whale tracking (Glassnode/Arkham/Nansen)
- **Build**: 2-3 hét
- **Score**: 5.5 (csökkent, mert #2 lefedi a Polymarket-on-belüli whale tracking-et)
- Nagy wallet movements (exchange inflow/outflow), miner reserves
- Glassnode API ~$30/hó (basic tier)
- **Marginal benefit a #2 (apex v2) után erősen csökken** — overlap. Csak akkor építsd, ha a #2 nem ad elég insider signalt.

### #14 — News headline NLP (Bloomberg/Reuters RSS + Claude)
- **Build**: 2-3 hét
- **Score**: 6.0
- RSS feed → headline → Claude classification: "BTC bullish/bearish/neutral, +1/-1/0 impact score"
- Claude API costs ~$10-20/hó, signal-ként a combiner-be

### #15 — Random Forest / XGBoost feature ensemble
- **Build**: 3-4 hét
- **Score**: 6.0
- 8+ signal → ML model, nem lineáris súlyozás
- **Csak** ha 1000+ live trade van (különben overfitting)

### #16 — Reddit / 4chan sentiment (r/wallstreetbets, r/cryptocurrency)
- **Build**: 1-2 hét
- **Score**: 5.5
- Reddit API ingyenes, /r/wallstreetbets nagy retail signal
- Aszinkron, slow-changing — heti újrakomputálás elég

### #17 — Funding rate cross-section (top 10 coin percentile rank)
- **Build**: 1 hét
- **Score**: 5.5
- Ha minden coin extreme positive funding → market overheated → contrarian signal
- A meglévő funding-rates signal bővítése

### #18 — Conditional Value-at-Risk (CVaR) sizing
- **Build**: 1-2 hét
- **Score**: 5.5
- Kelly helyett vagy mellett tail-risk-aware sizing
- Csak ha komolyan nőtt a bankroll ($5k+)

### #19 — Mempool monitoring (Polygon pending transactions)
- **Build**: 2-3 hét
- **Score**: 5.0
- Saját Polygon node (Hetzner-en) → pending trade-ek látása mielőtt confirm
- Frontrun defense + potenciálisan edge
- Drága infrastruktúra (saját RPC node ~€20/hó plusz traffic)

### #20 — Drift Protocol (Solana perps) — új venue
- **Build**: 2-3 hét
- **Score**: 5.0
- Solana DEX, gyakran másabb funding rates mint EVM
- Cross-DEX funding arb opportunity (Drift vs HL)

### #21 — Deribit options
- **Build**: 3-4 hét
- **Score**: 5.0
- BTC/ETH options → direkt vol trade (nem proxin keresztül)
- **De**: opciós kereskedés saját skill set, nem just "új venue"

---

## 3. RANGSOR — Long-term (12+ hónap, ha minden más jól megy)

### #22 — Kalman filter trend estimation
- **Score**: 4.5
- Noise-reduction price track, trend extraction
- Marginal javítás a meglévő momentum signal-on

### #23 — LSTM / Transformer price prediction
- **Score**: 4.0
- Short-horizon predictor
- ML overhead vs marginal benefit kérdéses

### #24 — Reinforcement Learning execution agent (PPO)
- **Score**: 4.0
- Order placement timing/sizing optimalizálás
- Sim env-en train kell — építeni kell egy szimulátort
- 2-3 hónap fejlesztés, bizonytalan ROI

### #25 — Bayesian portfolio optimization
- **Score**: 4.0
- Prior + posterior weights több stratégián
- **Csak ha koordinátorra váltottál** (lásd risk-coordinator-considerations.md §4)

### #26 — Toxic flow detection (per-wallet VPIN Polymarket-en)
- **Score**: 4.0
- Mely whale-ek a "toxic" oldal — adverse selection elkerülés
- Marginális javítás, complex implementáció

### #27 — Cross-asset Hawkes (BTC trade event triggers ETH)
- **Score**: 4.0
- A meglévő Hawkes signal bővítése
- Nehéz validálni, kis incremental edge

### #28 — L2 / L3 order book imbalance (queue position)
- **Score**: 4.0
- Mély book imbalance, queue position
- Polymarket CLOB-on lehet, de a depth limit-ek miatt csak top 10-20 level
- Marginal javítás a meglévő orderflow-n

### #29 — Sportradar / Pinnacle sport markets cross-arb
- **Score**: 4.0
- Polymarket sport markets vs Pinnacle "true odds"
- **Új pillér**: `pillar-sports`
- Sport-specifikus szabályok és events-ek külön rendszer

### #30 — Election / Politics markets pillér
- **Score**: 3.5
- News-driven, hosszabb idejű piacok
- LLM-based news sentiment kell hozzá (#13)

### #31 — Macro / Fed markets pillér
- **Score**: 3.5
- CPI, jobs, rate decisions
- FRED API + economic calendar integration
- Eseményvezérelt (havonta 4-6 esemény), nem busy

### #32 — dYdX / GMX / Vertex / Aevo (új DEX-ek)
- **Score**: 3.5
- Több venue → több arb opportunity
- Mindegyik adapter ~1 hét fejlesztés

### #33 — Crypto.com / OKX / Bitget (még több venue)
- **Score**: 3.0
- Diminishing returns adapter építéskor

### #34 — Music / entertainment markets (Grammy, box office)
- **Score**: 3.0
- Niche, kevés bot, potenciálisan nagyobb edge
- Volume nagyon kicsi → marginal $

### #35 — GitHub commits monitoring (protocol upgrade detection)
- **Score**: 2.5
- Long-tail signal, ritka events
- Nehéz monetizálni

### #36 — Distributed strategy execution (multi-VPS, geo-distributed)
- **Score**: 2.5
- Csak ha **bizonyítottan** kell az AWS Tokyo edge node a latency-arb-hoz
- Ne építsd amíg paper-en nem győz

### #37 — Co-location AWS Tokyo
- **Score**: 2.0 (jelenleg)
- Lásd #35 — csak ha latency-arb pillér profitabilis
- $15-50/hó plusz

---

## 4. Realisztikus 12 hónapos terv

### Hónap 0-3: VPS migráció + bug fix + apex v2
- Migration plan végrehajtása (3 hónap)
- #1 apex bug fix (Phase 2 alatt)
- #2 apex-wallets v2 (insider + smart money + wash + followed) — Phase 2-3 átfedéssel
- #3 per-coin signal slug map (Phase 2)

### Hónap 3-6: Foundation reinforcement
- #4 WebSocket VWAP scanner
- #5 Walk-forward backtest framework
- #6 Brier score + reliability diagram
- Latency-arb pillér paper → live (vagy nyugdíjazás)

### Hónap 6-9: Új edge sources
- #7 Liquidation cascade detection (új pillér)
- #8 GARCH(1,1) vol-divergence javítás
- Postgres trade history 500+ trade → első IC recalibration

### Hónap 9-12: Diverzifikáció
- #9 Polymarket-Kalshi arb (ha access megoldva)
- #11 HMM regime detection
- #12 Pairs trading
- 1-2 fail-fast experiment a #15 ML modellel

### Hónap 12+: Skálázás vagy specializálás
- Eddigre tudni fogod **melyik pillér nyer és melyik nem**
- A nyertesekbe öntsd a tőkét (bankroll átcsoportosítás)
- A vesztesek **nyugdíjazás vagy refactor**
- Risk coordinator építés ha a §4 trigger-ek aktiválódtak

---

## 5. Mit NEM csinálsz (anti-roadmap)

**Csábító ötletek, amiket aktívan kerülni kell**:

### "Adjuk hozzá az ML-t mindenhez"
- Az ML overfitting risk-je >> marginal edge gain a meglévő signal-okon, **amíg nincs 1000+ trade**.
- A `coinman2` wallet **nem ML-t használt**, hanem fix szabály-alapú signal-okat. Ezt a leírás explicit mondja.

### "Csatlakozzunk minden venue-höz"
- Adapter építés időigényes, és a **kis venue-k tiny edge-et** adnak.
- **Top 3 venue (Polymarket, HL, Bybit) elég** induláskor. Negyediket csak akkor, ha az első 3 telített.

### "Build our own LLM-based reasoning engine"
- A leírás szerinti "Claude reasons about market, makes decisions" megvan a **resolution-risk** signal-ben (Claude API).
- **Ne építs autonóm AI agent-eket**, mert imprediktábilis döntéseket hoznak. Te akarsz konzisztens szabályokat, nem GenAI hallucinációt.

### "Copy-trade whales"
- Az apex-wallets signal **már egy whale aggregátor**.
- Direct copy-trade lag-et hoz (te a tx után másolsz, mire benyomod a market már mozdult).
- **A jelenlegi rendszer ennél jobb**: te magad döntesz a whale-ek consensus-a alapján.

### "Egy nagy futuristic ML rendszer mindent felülír"
- A real-world trading rendszerek **modulárisak és kalibráltak**. Nem 1 nagy fekete doboz.
- Renaissance Technologies (a legendás Medallion fund) is **több ezer kis stratégiát** futtat, nem egy mega-modellt.

---

## 6. Konkrét következő lépés

**Most**: a #1 (apex bug fix) + a `migration-strangler-fig.md` Phase 0 indítás. Az #1 előbb fixáld, mert a #2 (apex v2) ráépül.

**1 hónap múlva**: Phase 2 alatt #2 (apex v2) tervezés és kódolás kezdés + #3 (per-coin signal slug) + #4 (WS VWAP) tervezés.

**3 hónap múlva**: Migráció kész, apex v2 working, Edge Tracker mutat 200+ live trade-et minden pillérnek. Akkor visszanézed ezt a doksit, és **adatvezérelten** dönt a #5-#11 sorrendéről.

**Ne** ess pánikba ha látsz "csak" 5 pillért. **5 jól-kalibrált pillér** > 20 rosszul-kalibrált. A `coinman2` wallet egyetlen stratégiát futtat (latency-arb). Nem a stratégiák száma, hanem a **konzisztencia** számít.

---

## 7. A polyterm referencia jegyzet

A #2 (apex v2) **ihletet merít** a polyterm Python projekt nyitott forrásából (`github.com/NYTEMODEONLY/polyterm`), de **nem dependency**:

- **Mit nézz meg ott**: `core/insider_detection.py`, `core/wash_detector.py`, `core/whale_tracker.py`, `core/risk_grading.py` — logikai minták, nem konkrét kód másolat.
- **Mit ne csinálj**: ne pip install polyterm-et a VPS-re és ne hívd subprocess-ből. Nem stack-fit (Python vs Bun TS), és dependency lock-in.
- **Hasznos megfigyelés a polyterm doksiban**: a Polymarket Subgraph API már részben deprecated, és a polyterm fallback aggregator pattern-t használ. Ezt a megközelítést érdemes követni az apex v2-ben is — Gamma + Data API + CLOB cross-validation, ne támaszkodj egyetlen forrásra.

---

**Összefüggő dokumentumok**:
- `hetzner-infrastructure.md` — VPS layout
- `migration-strangler-fig.md` — Netlify→VPS lépések
- `risk-coordinator-considerations.md` — pilléres modell trade-off-jai
- `../current-state/architecture.md` — jelenlegi state
